// PULL-3 fixture：实网小拉取。伪 HOME 里放一条真实的 github 条目（huashu-proofreading，
// alchaincyf/huashu-skills 的子目录，单文件 skill），走同一套 pullPending 真拉一次。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const home = process.env.USERPROFILE ?? process.env.HOME;
const pluginRoot = path.resolve(import.meta.dirname, "..", "..");
const lib = (name) => import(pathToFileURL(path.join(pluginRoot, "lib", name)).href);
const skillsrc = await lib("skillsrc.js");
const pending = await lib("pending.js");

const dsh = path.join(home, ".dsh");
const external = path.join(home, ".agents", "skills");
fs.mkdirSync(path.join(dsh, "dsh-studio"), { recursive: true });
fs.mkdirSync(external, { recursive: true });
fs.writeFileSync(path.join(dsh, "dsh-studio", "extractor.json"), JSON.stringify({ agentSkillDir: external }, null, 2) + "\n");

const pendingFile = await pending.pendingPullsPath();
fs.writeFileSync(
	pendingFile,
	JSON.stringify(
		{
			note: "实网自证：单文件小 skill",
			at: new Date().toISOString(),
			pulls: [
				{
					name: "huashu-proofreading",
					source: "https://github.com/alchaincyf/huashu-skills",
					ref: "master",
					sha: "",
					subdir: "huashu-proofreading"
				}
			]
		},
		null,
		2
	) + "\n"
);

const result = await pending.pullPending({ targetDir: external });
const lock = await skillsrc.loadLock();
const landed = path.join(external, "huashu-proofreading", "SKILL.md");

process.stdout.write(
	JSON.stringify({
		result,
		lock: lock["huashu-proofreading"] ?? null,
		pendingFile,
		pendingExists: fs.existsSync(pendingFile),
		landed: fs.existsSync(landed),
		head: fs.existsSync(landed) ? fs.readFileSync(landed, "utf8").split("\n").slice(0, 3) : []
	})
);
