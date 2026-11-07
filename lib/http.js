/**
 * 统一带超时的 fetch（S-04 / OPT-06）。
 *
 * 以前 webdav、s3、gist raw_url、MCP 的 HttpChannel 各自裸调 fetch：
 * 对端不回包时面板就一直挂着。这里统一套 30s 上限（与 gist 原有口径一致）。
 * 调用方自带 signal 时与超时信号合并，两边的取消语义都保留。
 */

/** 默认超时：30 秒。 */
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;

/**
 * @param {string|URL} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @param {typeof fetch} fetchImpl 换掉 fetch 实现（测试替身 / 自定义通道）
 * @returns {Promise<Response>}
 */
export async function fetchWithTimeout(url, init = {}, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, fetchImpl = fetch) {
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = init.signal !== undefined && init.signal !== null ? AbortSignal.any([init.signal, timeout]) : timeout;
	return fetchImpl(url, { ...init, signal });
}
