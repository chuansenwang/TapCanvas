import type { AppContext } from "../../types";
import { resolveRustfsConfig } from "./rustfs.client";

function readLocalAssetStorageDir(env: Pick<AppContext, "env">["env"]): string {
	const direct = typeof env.LOCAL_ASSET_STORAGE_DIR === "string" ? env.LOCAL_ASSET_STORAGE_DIR.trim() : "";
	if (direct) return direct;
	return typeof process.env.LOCAL_ASSET_STORAGE_DIR === "string" ? process.env.LOCAL_ASSET_STORAGE_DIR.trim() : "";
}

function readLocalAssetPublicBase(env: Pick<AppContext, "env">["env"]): string {
	const direct = typeof env.LOCAL_ASSET_PUBLIC_BASE_URL === "string" ? env.LOCAL_ASSET_PUBLIC_BASE_URL.trim() : "";
	if (direct) return direct.replace(/\/+$/, "");
	const fromProcess = typeof process.env.LOCAL_ASSET_PUBLIC_BASE_URL === "string" ? process.env.LOCAL_ASSET_PUBLIC_BASE_URL.trim() : "";
	return fromProcess ? fromProcess.replace(/\/+$/, "") : "";
}

/**
 * Resolve the publicly-accessible base URL for hosted assets.
 *
 * Priority:
 * 1) Explicit storage public base derived from `R2_PUBLIC_BASE_URL` / `RUSTFS_PUBLIC_BASE_URL`.
 * 2) If storage is configured but no direct public base exists, proxy via this API's `/assets/r2`.
 */
export function resolvePublicAssetBaseUrl(
	c: Pick<AppContext, "env" | "req">,
): string {
	const localPublicBase = readLocalAssetPublicBase(c.env);
	if (localPublicBase) return localPublicBase;
	if (readLocalAssetStorageDir(c.env)) {
		try {
			const requestUrl = new URL(c.req.url);
			return `${requestUrl.origin}/assets/local`;
		} catch {
			// ignore invalid request urls
		}
	}
	const storage = resolveRustfsConfig(c.env);
	if (!storage) return "";
	if (storage.publicBase) return storage.publicBase;
	try {
		const requestUrl = new URL(c.req.url);
		return `${requestUrl.origin}/assets/r2`;
	} catch {
		// ignore invalid request urls
	}
	return "";
}
