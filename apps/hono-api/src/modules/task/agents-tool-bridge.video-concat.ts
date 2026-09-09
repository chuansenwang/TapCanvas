import type { AppContext } from "../../types";
import { randomUUID } from "node:crypto";
import { AppError } from "../../middleware/error";
import { concatVideosFromUrls, type ConcatClipSpec } from "../apiKey/video-concat";
import { mapFlowRowToDto, updateFlow, type FlowRow } from "../flow/flow.repo";
import { sanitizeFlowDataForStorage } from "../flow/flow.service";
import { PublicFlowGraphSchema } from "../flow/flow.public.schemas";
import { applyPublicFlowGraphPatch, buildCanvasSyncPatch } from "../flow/flow.public.service";
import { broadcastPatch } from "../chapter/canvas-sse.manager";
import { applyPatchToFlowYDoc } from "../realtime/yjs-realtime";

function readTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Resolve a node's video URL (data.videoUrl, else first videoResults[].url) from
// the current flow row — lets 小T pass shot node ids instead of raw URLs.
function resolveVideoUrlFromFlowNode(row: FlowRow, nodeId: string): string {
  const dto = mapFlowRowToDto(row);
  const data = sanitizeFlowDataForStorage(dto.data ?? {});
  const nodes = Array.isArray((data as Record<string, unknown>).nodes)
    ? ((data as Record<string, unknown>).nodes as Array<Record<string, unknown>>)
    : [];
  const node = nodes.find((n) => String(n.id ?? "") === nodeId);
  if (!node) return "";
  const nodeData =
    node.data && typeof node.data === "object" && !Array.isArray(node.data)
      ? (node.data as Record<string, unknown>)
      : {};
  const direct = readTrimmedString(nodeData.videoUrl);
  if (direct) return direct;
  const videoResults = Array.isArray(nodeData.videoResults) ? nodeData.videoResults : [];
  for (const item of videoResults) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const url = readTrimmedString((item as Record<string, unknown>).url);
    if (url) return url;
  }
  return "";
}

export type ConcatVideosToCanvasResult = {
  ok: true;
  videoUrl: string;
  key: string;
  clipCount: number;
  bytes: number;
  canvasNodeId: string;
  concatPolicy: {
    joinMode: "hard_cut" | "xfade";
    xfadeSeconds: number;
    colorMatch: boolean;
  };
};

async function persistConcatResultNode(input: {
	c: AppContext;
	requestUserId: string;
	row: FlowRow;
	videoUrl: string;
	key: string;
	clipCount: number;
	clipNodeIds: string[];
	fileName?: string;
	targetAspect?: string;
	concatPolicy: ConcatVideosToCanvasResult["concatPolicy"];
}): Promise<string> {
	const dto = mapFlowRowToDto(input.row);
	const current = sanitizeFlowDataForStorage(dto.data ?? {});
	const nodeId = `film-${randomUUID()}`;
	const existingNodes = Array.isArray((current as Record<string, unknown>).nodes)
		? ((current as Record<string, unknown>).nodes as Array<Record<string, unknown>>)
		: [];
	const maxX = existingNodes.reduce((max, node) => {
		const position = node.position && typeof node.position === "object" && !Array.isArray(node.position)
			? (node.position as Record<string, unknown>) : {};
		const x = typeof position.x === "number" ? position.x : 0;
		return Math.max(max, x);
	}, 0);
	const patch = {
		createNodes: [{
			id: nodeId,
			type: "taskNode",
			position: { x: maxX + 520, y: 0 },
			data: {
				kind: "composeVideo",
				label: input.fileName || "合并视频",
				status: "success",
				videoUrl: input.videoUrl,
				videoResults: [{ url: input.videoUrl, assetId: input.key, duration: null }],
				videoModel: "ffmpeg-concat",
				...(input.targetAspect ? { aspect: input.targetAspect } : {}),
				clipCount: input.clipCount,
				concatPolicy: input.concatPolicy,
			},
		}],
		...(input.clipNodeIds.length ? {
			createEdges: input.clipNodeIds.map((source) => ({
				id: `e-${source}-${nodeId}`,
				source,
				target: nodeId,
				sourceHandle: "out-video",
				targetHandle: "in-any",
			})),
		} : {}),
	};
	const applied = applyPublicFlowGraphPatch({ current, patch });
	const sanitizedNext = sanitizeFlowDataForStorage(applied.data);
	const parsed = PublicFlowGraphSchema.safeParse(sanitizedNext);
	if (!parsed.success) throw new Error("合片结果节点写回失败：画布数据校验不通过");
	const updated = await updateFlow(input.c.env.DB, {
		id: input.row.id,
		name: input.row.name,
		data: JSON.stringify(sanitizedNext),
		ownerId: input.requestUserId,
		projectId: input.row.project_id,
		nowIso: new Date().toISOString(),
		expectedRevision: dto.canvasRevision,
		source: "agent",
	});
	if (!updated) throw new Error("合片结果节点写回失败：Flow 不存在");
	if (input.row.project_id) {
		const syncPatch = buildCanvasSyncPatch({ applied, patch, data: parsed.data });
		if (syncPatch) {
			broadcastPatch(input.row.project_id, syncPatch, "");
			applyPatchToFlowYDoc(input.row.id, syncPatch);
		}
	}
	return nodeId;
}

/**
 * Concatenate already-generated video clips (the S7 stage of the video workflow)
 * into a single mp4 and return its permanent URL. Accepts explicit `clipUrls` or
 * `nodeIds` (resolved from the current flow, in the order given). This is the
 * recovery/断点续跑-friendly: it only stitches existing clips, never regenerates. The caller then writes the result
 * to the canvas via flow_patch (mirrors how extract_last_frame returns a url).
 */
export async function concatVideosToCanvas(input: {
  c: AppContext;
  requestUserId: string;
  row: FlowRow | null;
  bodyArgs: unknown;
}): Promise<ConcatVideosToCanvasResult> {
  const args =
    input.bodyArgs && typeof input.bodyArgs === "object" && !Array.isArray(input.bodyArgs)
      ? (input.bodyArgs as Record<string, unknown>)
      : {};

  const readOptionalNumber = (value: unknown): number | undefined => {
    const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    return Number.isFinite(n) ? n : undefined;
  };

  // 富形态 clips：[{ url 或 nodeId, inSec?, outSec? }]，支持逐段内切与同源多区间复用。
  const richSpecs: ConcatClipSpec[] = (Array.isArray(args.clips) ? args.clips : []).flatMap(
    (entry): ConcatClipSpec[] => {
      if (typeof entry === "string" && entry.trim()) return [{ url: entry.trim() }];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const item = entry as Record<string, unknown>;
      let url = readTrimmedString(item.url);
      const nodeId = readTrimmedString(item.nodeId);
      if (!url && nodeId) {
        if (!input.row) {
          throw new AppError("Flow not found", { status: 404, code: "flow_not_found" });
        }
        url = resolveVideoUrlFromFlowNode(input.row, nodeId);
        if (!url) {
          throw new AppError(`node ${nodeId} has no videoUrl`, {
            status: 400,
            code: "agents_tool_concat_node_no_video",
            details: { nodeId },
          });
        }
      }
      if (!url) return [];
      return [{
        url,
        inSec: readOptionalNumber(item.inSec),
        outSec: readOptionalNumber(item.outSec),
        transition: readTrimmedString(item.transition) || undefined,
      }];
    },
  );

  const explicitUrls = Array.isArray(args.clipUrls)
    ? (args.clipUrls as unknown[]).map(readTrimmedString).filter(Boolean)
    : [];
  const nodeIds = Array.isArray(args.nodeIds)
    ? (args.nodeIds as unknown[]).map(readTrimmedString).filter(Boolean)
    : [];

  let clipUrls: Array<string | ConcatClipSpec> = richSpecs.length >= 2 ? richSpecs : explicitUrls;
  if (clipUrls.length < 2 && nodeIds.length >= 2) {
    if (!input.row) {
      throw new AppError("Flow not found", { status: 404, code: "flow_not_found" });
    }
    const row = input.row;
    clipUrls = nodeIds.map((id) => {
      const url = resolveVideoUrlFromFlowNode(row, id);
      if (!url) {
        throw new AppError(`node ${id} has no videoUrl`, {
          status: 400,
          code: "agents_tool_concat_node_no_video",
          details: { nodeId: id },
        });
      }
      return url;
    });
  }

  if (clipUrls.length < 2) {
    throw new AppError("clips, clipUrls or nodeIds must resolve to at least 2 video clips", {
      status: 400,
      code: "agents_tool_concat_missing_clips",
    });
  }

  const fileName = readTrimmedString(args.fileName) || undefined;
  const targetAspect =
    readTrimmedString(args.aspect) || readTrimmedString(args.aspectRatio) || undefined;
  const xfadeSeconds = readOptionalNumber(args.xfadeSeconds);
  const colorMatch = typeof args.colorMatch === "boolean" ? args.colorMatch : undefined;
  try {
    const result = await concatVideosFromUrls(
      input.c,
      input.requestUserId,
      clipUrls,
      fileName,
      targetAspect,
      { xfadeSeconds, colorMatch, allowLocalMediaProcessing: true },
    );
    const createNode = args.createNode === true;
    if (!createNode) {
      return {
        ok: true,
        videoUrl: result.url,
        key: result.key,
        clipCount: result.clipCount,
        bytes: result.bytes,
        concatPolicy: {
          joinMode: result.joinMode,
          xfadeSeconds: result.xfadeSeconds,
          colorMatch: result.colorMatch,
        },
      };
    }
    if (!input.row) throw new AppError("Flow not found", { status: 404, code: "flow_not_found" });
    const clipNodeIds = [
      ...nodeIds,
      ...richSpecs.flatMap((spec, index) => {
        const entry = Array.isArray(args.clips) ? args.clips[index] : null;
        return entry && typeof entry === "object" && !Array.isArray(entry)
          ? [readTrimmedString((entry as Record<string, unknown>).nodeId)].filter(Boolean)
          : [];
      }),
    ];
    const canvasNodeId = await persistConcatResultNode({
      c: input.c,
      requestUserId: input.requestUserId,
      row: input.row,
      videoUrl: result.url,
      key: result.key,
      clipCount: result.clipCount,
      clipNodeIds: [...new Set(clipNodeIds)],
      fileName,
      targetAspect,
      concatPolicy: { joinMode: result.joinMode, xfadeSeconds: result.xfadeSeconds, colorMatch: result.colorMatch },
    });
    return {
      ok: true,
      videoUrl: result.url,
      key: result.key,
      clipCount: result.clipCount,
      bytes: result.bytes,
      canvasNodeId,
      concatPolicy: {
        joinMode: result.joinMode,
        xfadeSeconds: result.xfadeSeconds,
        colorMatch: result.colorMatch,
      },
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
		const reason = err instanceof Error ? err.message : String(err);
		throw new AppError(`视频拼接失败：${reason}`, {
      status: 502,
      code: "agents_tool_concat_failed",
      details: { message: reason },
    });
  }
}
