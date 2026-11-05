import path from 'node:path';

/** 运行期数据目录（截图、Chrome 配置、图片指纹缓存） */
export const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
export const SHOT_DIR = process.env.SHOT_DIR || path.join(DATA_DIR, 'shots');
export const PROFILE_DIR = process.env.SHOT_PROFILE || path.join(DATA_DIR, 'chrome-profile');

/** 允许调用接口的站点。留空 = 不校验来源（本机/内网自用） */
export const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function originAllowed(origin) {
  if (!origin) return true;
  if (!ALLOWED_ORIGINS.length) return true;
  return ALLOWED_ORIGINS.includes(origin);
}

/** 抓取网页时使用的 UA（部分站点会按 UA 判断是否允许读取） */
export const USER_AGENT = process.env.USER_AGENT || 'ArticleLinkChecker/1.0';

/** Word 修订稿里显示的修订人 */
export const REPORT_AUTHOR = process.env.REPORT_AUTHOR || 'Article Link Checker';
