// 频道元数据采集（在 YouTube 频道页面的页面上下文中执行）
//
// 用法：把本文件内容原样交给浏览器工具的 evaluate 执行，反复执行同一段脚本，
// 直到返回值的 done === true。脚本用 window.__channelHarvest 保存中间状态，
// 因此中途换用其它调用不会丢进度，重复执行也不会重复抓取。
//
// 返回结构：
//   { phase, done, total, fetched, remaining, channel, batch, errors }
//
// 约定：抓不到的字段一律返回 null，绝不填充默认值或占位文本。

const cfg = window.ytcfg;
if (!cfg) {
  return JSON.stringify({
    phase: "error",
    error: "ytcfg 不存在：当前页面不是 YouTube 页面，请先打开目标频道的 /videos 页。",
  });
}

const apiKey = cfg.get("INNERTUBE_API_KEY");
const apiContext = cfg.get("INNERTUBE_CONTEXT");
if (!apiKey || !apiContext) {
  return JSON.stringify({
    phase: "error",
    error: "缺少 INNERTUBE_API_KEY / INNERTUBE_CONTEXT，请刷新频道页后重试。",
  });
}

// 单次 evaluate 有 30 秒上限，因此每次只处理一小批，由调用方重复执行直到 done。
const BATCH_SIZE = 10;
const CONCURRENCY = 5;
const VIDEOS_TAB_PARAMS = "EgZ2aWRlb3PyBgQKAjoA";

const state = (window.__channelHarvest = window.__channelHarvest || {
  channel: null,
  ids: null,
  results: [],
  cursor: 0,
  errors: [],
});

const post = async (path, body) => {
  const response = await fetch(`${path}?key=${apiKey}&prettyPrint=false`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${path} 返回 HTTP ${response.status}`);
  }
  return response.json();
};

const toNumber = (text) => {
  const match = String(text ?? "").replace(/[,\s]/g, "").match(/\d+/);
  return match ? Number(match[0]) : null;
};

// 收集一个对象里所有 buttonViewModel.accessibilityText，用于识别点赞按钮。
const collectAccessibilityTexts = (root) => {
  const texts = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const text = node.buttonViewModel?.accessibilityText;
    if (typeof text === "string") texts.push(text);
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(root);
  return texts;
};

// 频道页头pageHeaderViewModel 里带订阅数、横幅与简介按钮文案。
const findPageHeaderViewModel = (root) => {
  let found = null;
  const walk = (node) => {
    if (!node || typeof node !== "object" || found) return;
    if (node.pageHeaderViewModel) {
      found = node.pageHeaderViewModel;
      return;
    }
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(root);
  return found;
};

// 频道关键词在 metadata 里是带引号的空格分隔串，需要还原成数组。
const parseKeywords = (raw) => {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const quoted = [...text.matchAll(/"([^"]+)"/g)].map((match) => match[1].trim());
  if (quoted.length > 0) return quoted.filter(Boolean);
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
};

// 找评论区的续接令牌，用于单独请求评论总数。
const findCommentToken = (root) => {
  let token = null;
  const walk = (node) => {
    if (!node || typeof node !== "object" || token) return;
    const section = node.itemSectionRenderer;
    if (section?.sectionIdentifier === "comment-item-section") {
      const inner = section.contents?.[0]?.continuationItemRenderer;
      const candidate = inner?.continuationEndpoint?.continuationCommand?.token;
      if (candidate) token = candidate;
    }
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(root);
  return token;
};

const findCommentCount = (root) => {
  let count = null;
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const countText = node.commentsHeaderRenderer?.countText;
    if (countText) {
      const text = countText.runs?.map((run) => run.text).join("") ?? countText.simpleText;
      const parsed = toNumber(text);
      if (parsed !== null) count = parsed;
    }
    const simple = node.commentsHeaderRenderer?.commentsCount?.simpleText;
    if (simple) {
      const parsed = toNumber(simple);
      if (parsed !== null) count = parsed;
    }
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(root);
  return count;
};

const findContinuation = (root) => {
  let token = null;
  const walk = (node) => {
    if (!node || typeof node !== "object" || token) return;
    const candidate =
      node.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token;
    if (candidate) {
      token = candidate;
      return;
    }
    for (const key of Object.keys(node)) walk(node[key]);
  };
  walk(root);
  return token;
};

// 阶段一：读取频道信息，并按分页抓完整个视频 ID 列表。
if (!state.ids) {
  const meta = window.ytInitialData?.metadata?.channelMetadataRenderer;
  if (!meta?.externalId) {
    return JSON.stringify({
      phase: "error",
      error: "当前页面不是频道页，请在目标频道的 /videos 页面执行本脚本。",
    });
  }

  state.channel = {
    name: meta.title ?? null,
    channelId: meta.externalId,
    handle: meta.vanityChannelUrl ?? null,
    url: meta.channelUrl ?? `https://www.youtube.com/channel/${meta.externalId}`,
    description: meta.description ?? "",
    keywords: parseKeywords(meta.keywords),
    avatarUrl: (meta.avatar?.thumbnails ?? []).slice(-1)[0]?.url ?? null,
    bannerUrl: null,
    subscriberCountText: null,
    videoCountText: null,
    viewCountText: null,
    joinedDateText: null,
    country: null,
  };

  // 订阅数与横幅来自频道页头；不依赖需要额外展开的 About 弹层。
  const header = findPageHeaderViewModel(window.ytInitialData);
  if (header) {
    const metadata = header.metadata?.contentMetadataViewModel;
    const parts = (metadata?.metadataRows ?? [])
      .flatMap((row) => (row.metadataParts ?? []).map((part) => part.text?.content))
      .filter((text) => typeof text === "string");
    state.channel.subscriberCountText =
      parts.find((text) => /订阅者|subscriber/i.test(text)) ?? null;
    state.channel.videoCountText =
      parts.find((text) => /视频|video/i.test(text)) ?? null;
    state.channel.bannerUrl =
      header.banner?.imageBannerViewModel?.image?.sources?.slice(-1)[0]?.url ?? null;
  }

  const ids = new Set();
  let page = await post("/youtubei/v1/browse", {
    context: apiContext,
    browseId: state.channel.channelId,
    params: VIDEOS_TAB_PARAMS,
  });
  for (let pageIndex = 0; pageIndex < 40; pageIndex += 1) {
    for (const match of JSON.stringify(page).matchAll(/"videoId":"([\w-]{11})"/g)) {
      ids.add(match[1]);
    }
    const token = findContinuation(page);
    if (!token) break;
    page = await post("/youtubei/v1/browse", {
      context: apiContext,
      continuation: token,
    });
  }

  if (ids.size === 0) {
    return JSON.stringify({
      phase: "error",
      error: "频道 /videos 分组没有返回任何视频 ID，请确认频道存在公开视频。",
    });
  }

  state.ids = [...ids];
  return JSON.stringify({
    phase: "list",
    done: false,
    total: state.ids.length,
    fetched: 0,
    remaining: state.ids.length,
    channel: state.channel,
    batch: [],
    errors: state.errors,
  });
}

// 阶段二：分批抓取视频详情，并按需补一次请求取评论总数。
const batch = state.ids.slice(state.cursor, state.cursor + BATCH_SIZE);
const records = [];

for (let index = 0; index < batch.length; index += CONCURRENCY) {
  const slice = batch.slice(index, index + CONCURRENCY);
  const settled = await Promise.all(
    slice.map(async (videoId) => {
      try {
        const [player, next] = await Promise.all([
          post("/youtubei/v1/player", {
            context: apiContext,
            videoId,
            contentCheckOk: true,
            racyCheckOk: true,
          }),
          post("/youtubei/v1/next", { context: apiContext, videoId }),
        ]);

        const details = player.videoDetails;
        if (!details?.title) {
          throw new Error("player 接口没有返回 videoDetails.title");
        }
        const microformat = player.microformat?.playerMicroformatRenderer ?? {};

        const likeText = collectAccessibilityTexts(next).find((text) =>
          /顶此视频|like this video/i.test(text),
        );

        let commentCount = null;
        const commentToken = findCommentToken(next);
        if (commentToken) {
          try {
            const commentPage = await post("/youtubei/v1/next", {
              context: apiContext,
              continuation: commentToken,
            });
            commentCount = findCommentCount(commentPage);
          } catch (error) {
            state.errors.push(
              `评论数采集失败（${videoId}）：${String(error?.message ?? error)}`,
            );
          }
        }

        return {
          id: videoId,
          title: details.title,
          description: details.shortDescription ?? "",
          url: `https://www.youtube.com/watch?v=${videoId}`,
          durationSeconds: details.lengthSeconds ? Number(details.lengthSeconds) : null,
          uploadDate: microformat.uploadDate ?? null,
          publishDate: microformat.publishDate ?? null,
          viewCount: details.viewCount ? Number(details.viewCount) : null,
          likeCount: toNumber(likeText),
          commentCount,
          category: microformat.category ?? null,
          tags: details.keywords ?? [],
          thumbnailUrl:
            (microformat.thumbnail?.thumbnails ?? []).slice(-1)[0]?.url ??
            `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
          chapters: details.chapters ?? [],
        };
      } catch (error) {
        state.errors.push(`视频采集失败（${videoId}）：${String(error?.message ?? error)}`);
        return {
          id: videoId,
          title: null,
          description: null,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          durationSeconds: null,
          uploadDate: null,
          publishDate: null,
          viewCount: null,
          likeCount: null,
          commentCount: null,
          category: null,
          tags: [],
          thumbnailUrl: null,
          chapters: [],
        };
      }
    }),
  );
  records.push(...settled);
}

state.results.push(...records);
state.cursor += batch.length;

return JSON.stringify({
  phase: "videos",
  done: state.cursor >= state.ids.length,
  total: state.ids.length,
  fetched: state.results.length,
  remaining: state.ids.length - state.cursor,
  channel: state.channel,
  batch: records,
  errors: state.errors.slice(-10),
});
