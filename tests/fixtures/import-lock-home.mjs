// U-3 fixture：在伪 HOME 里用本地 tarball 跑导入（子目录 + 二次幂等），把结果与写出的 lock 交给父测试断言。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const { importSkill, loadLock, lockPath } = await import(pathToFileURL(path.join(pluginRoot, "lib", "skillsrc.js")).href);

// tarball 顶层是 `<repo>-<ref>/`，下面再放子目录 —— 与 GitHub codeload 的形状一致
const pkgRoot = path.join(home, "pkg");
const subDir = path.join(pkgRoot, "repo-main", "demo-sub");
fs.mkdirSync(subDir, { recursive: true });
fs.writeFileSync(path.join(subDir, "SKILL.md"), "---\nname: demo-sub\ndescription: 子目录导入\n---\nbody");
fs.writeFileSync(path.join(subDir, "extra.md"), "extra\n");
const tgz = path.join(home, "demo.tgz");
execFileSync("tar", ["-czf", tgz, "-C", pkgRoot, "repo-main"], { stdio: "pipe" });

const targetDir = path.join(home, ".agents", "skills");
const first = await importSkill({ source: tgz, targetDir });
const second = await importSkill({ source: tgz, targetDir });
const lock = await loadLock();

process.stdout.write(JSON.stringify({ first, second, lock, lockFile: lockPath(), tgz, targetDir }));
