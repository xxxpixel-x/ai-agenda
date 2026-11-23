// 单次请求失败不能当成模型能力。尤其不能因为限流、鉴权或附件损坏永久关闭图片。
const accessError = /\bauth\b|authenticat|authori[sz]|unauthori|forbidden|access denied|permission denied|api[ _-]?key|invalid key|quota|rate[ _-]?limit|too many requests|insufficient|鉴权|密钥|配额|额度|限流/i;
const networkError = /network|fetch failed|time[ _-]?out|timed out|ECONN|ENOTFOUND|超时|网络/i;
const badAttachment = /too large|too many images|image size|image dimensions|image format|mime type|invalid base64|failed to decode|corrupt|invalid image (?:data|url)|图片格式|图片大小/i;

export function imageError(message) {
  if (!/\b4\d\d\b/.test(message) || /\b(?:401|403|408|429|5\d\d)\b/.test(message)) return false;
  if (accessError.test(message) || networkError.test(message) || badAttachment.test(message)) return false;
  const text = message.toLowerCase().replace(/[_-]/g, ' ').replace(/["'`]/g, '');
  if (/\bcontent type(?: header|[: ]+(?:application|multipart|text)\/)/.test(text)) return false;
  if (/(?:invalid|unsupported|unknown) content (?:part )?type|content\b.{0,60}(?:must be|expected) (?:a )?string/.test(text)) return true;
  if (/only (?:supports?|accepts?) text\b|(?:supports?|accepts?) (?:only text|text only)\b|(?:is|are) (?:a )?text only\b|[只仅]支持(?:纯)?文本/.test(text)) return true;
  const detail = text.replace(/\b(?:images?|vision|multi ?modal|content parts?)\b|图片|图像|视觉|多模态/g, 'image');
  return /(?:unsupported|unknown|unrecognized|unexpected|invalid (?:value|type|parameter))[: ]+(?:(?:input|type|parameter|field) )*image\b/.test(detail)
    || /(?:not|doesnt|cannot|cant) (?:currently )?(?:support|accept|process|handle|take|have) (?:any |an? |the )?image\b|no endpoints? (?:found )?that support image/.test(detail)
    || /image(?: (?:url|inputs?|content|parts?|type|mode|capabilit(?:y|ies)))* (?:(?:is|are) )?(?:unsupported|disabled|unavailable|not (?:supported|allowed|available|enabled|accepted|a valid)|only supported)/.test(detail)
    || /(?:不支持|不接受|不允许).*?image|image.*?(?:不支持|不受支持|不可用)/.test(detail);
}

export function supportsModelImages(conn, model) {
  const name = model || conn?.model || '';
  return conn?.images !== false && !conn?.disabledImages?.includes(name);
}
