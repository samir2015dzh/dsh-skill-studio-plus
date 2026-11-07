/**
 * 路径与 id 的统一闸门（WO-FIX-5）。
 *
 * snapshot / trash / sync 三处都有「拿外部数据拼路径」的入口：快照目录里的 id、
 * 回收站 manifest 里的 from/to、同步请求里的 snapshotId。以前各写一份、还漏了两处，
 * 现在统一从这里过一遍。
 */
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * 快照 / 批次 id：只允许单段目录名。
 * 带路径分隔符、`..`、或以点开头的一律拒绝 —— 这些值会直接被拼进 rm/mkdir 的路径。
 */
export function assertSnapshotId(id) {
	const value = typeof id === "string" ? id : "";
	if (value === "" || value !== value.trim()) throw new Error(`快照 id 不合法：${JSON.stringify(id)}`);
	if (value.includes("/") || value.includes("\\") || value.includes("..") || value.startsWith(".")) {
		throw new Error(`快照 id 只允许目录名，不能带路径：${value}`);
	}
	return value;
}

/**
 * tar 包内条目是否可安全落到某个根目录下。
 * 导入的包可能来自别人，`../../../x` 或绝对路径会让恢复写到根目录之外。
 */
export function isSafeEntryPath(rel) {
	if (typeof rel !== "string" || rel === "") return false;
	if (rel.startsWith("/") || rel.startsWith("\\")) return false;
	if (/^[a-zA-Z]:/.test(rel)) return false;
	const parts = rel.split(/[\\/]/);
	return parts.every((part) => part !== "" && part !== "." && part !== "..");
}

/** target 是否落在 root 之内（含 root 本身）。两边都会先 resolve。 */
export function isInside(root, target) {
	if (typeof root !== "string" || typeof target !== "string") return false;
	const base = resolve(root);
	const full = resolve(target);
	if (base === full) return true;
	const rel = relative(base, full);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** 把 root 与单段名字拼成路径，名字先过 id 闸门。 */
export function joinChecked(root, id) {
	return join(root, assertSnapshotId(id));
}

export { sep };
