/**
 * 凭据掩码（WO-SEC-1）。
 *
 * 原始凭据值只允许出现在一个地方：单点的 loopback 按需取用路由。
 * 任何会被序列化出去、被日志、被工具返回值带走的结构里，只能放这里的掩码。
 */

/** 看起来像凭据的键名。mcp.js / index.js / snapshot.js 共用同一口径。 */
export const SENSITIVE_KEY = /authorization|api[-_]?key|access[-_]?token|token|secret|password|cookie|credential/i;

/** 掩码：中间打点、尾 4 位（与面板原先的显示格式一致）。长值不会暴露长度以外的信息。 */
export function maskSecret(value) {
	const text = String(value ?? "");
	if (text.length <= 6) return "\u2022".repeat(Math.max(4, text.length));
	return "\u2022".repeat(8) + text.slice(-4);
}
