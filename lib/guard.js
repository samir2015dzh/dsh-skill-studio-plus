/**
 * 宿主的本机面板闸门（WO-SEC-1 引入，WO-SEC-2 全面套用）。
 *
 * 判定口径与 index.js 原 `isLoopbackRequest` 完全一致：来源地址必须在 loopback，
 * Host 必须是本机名，禁掉 `sec-fetch-site: cross-site`，Origin 有就必须同源。
 * 任何会写盘、spawn 进程、或吐凭据的路由都必须先过这一道。
 */

/** 请求是否来自本机面板（loopback + 同源）。 */
export function isLocalRequest(request) {
	const address = request.socket?.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL("http://" + host);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
