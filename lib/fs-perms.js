/**
 * 凭据文件的落盘权限（WO-SEC-3）。
 *
 * sync.json 存 gist token / s3 secretKey / webdav 密码，mcp.json 存 Authorization 头。
 * 新建时按 0600 创建；已存在的文件由 chmod 收紧一次。
 * Windows 上 mode 位语义有限（只有只读位），拿不到位就静默跳过 ——
 * 不能因为权限收不紧就拒绝保存配置。
 */
import { chmod } from "node:fs/promises";

/** 含凭据的文件按 0600 落盘：仅属主可读写。 */
export const CREDENTIAL_FILE_MODE = 0o600;

/** 收紧一份已存在文件的权限；失败不抛。 */
export async function hardenPermissions(path) {
	try {
		await chmod(path, CREDENTIAL_FILE_MODE);
	} catch {
		/* Windows / 网络盘 / 只读介质：跳过，不影响调用方 */
	}
}
