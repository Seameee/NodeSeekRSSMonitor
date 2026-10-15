// ============================================================================
// 命令清单一致性
//
// 用户反馈：管理员面板与 /help 的命令列表互相有缺失。根因是命令清单在 5 个
// 地方各写一份（/help、/admin 面板、/bind 提示、/ai 用法、命令菜单），
// 改一处必漏其余。现在统一由 help.js 供数，这组用例守住"不会再漂移"。
// ============================================================================
import test from "node:test";
import assert from "node:assert/strict";
import { teardown } from "./helpers.js";

const { buildHelp } = await import("../src/notify.js");
const { USER_HELP_SECTIONS, ADMIN_HELP_ITEMS, BOT_MENU, renderItems } = await import("../src/help.js");

test.after(async () => {
  await teardown();
});

test("一致性：/help 的管理员那节覆盖面板里的每一条命令", () => {
  const help = buildHelp(true);
  const missing = ADMIN_HELP_ITEMS.map(([c]) => c).filter((c) => !help.includes(c));
  assert.deepEqual(missing, [], `这些管理员命令在 /help 里缺失：${missing.join(" · ")}`);
});

test("一致性：管理员看到的是普通用户帮助的超集", () => {
  const user = buildHelp(false);
  const admin = buildHelp(true);
  for (const sec of USER_HELP_SECTIONS) {
    for (const [cmd] of sec.items) {
      assert.ok(admin.includes(cmd), `管理员视角缺少用户命令 ${cmd}`);
    }
  }
  assert.ok(!user.includes("管理员面板"), "普通用户不应看到管理面板");
});

test("一致性：命令菜单里的命令都有对应的帮助条目", () => {
  const help = buildHelp(true);
  for (const [name] of BOT_MENU) {
    assert.match(help, new RegExp(`/${name}\\b`), `命令菜单里的 /${name} 在 /help 中没有说明`);
  }
});

test("渲染：不得出现未转义的尖括号（会 Telegram 拒发）", () => {
  // 允许 Telegram HTML 解析模式支持的真实标签，其余 <...> 一律视为漏转义
  const allowed = /^<\/?(b|i|u|s|code|pre|a|details|summary|blockquote|cite|h3)[\s/>]/;
  for (const text of [buildHelp(false), buildHelp(true), renderItems(ADMIN_HELP_ITEMS)]) {
    for (const m of text.matchAll(/<[^<>]*>/g)) {
      assert.ok(
        allowed.test(m[0]),
        `发现未转义的尖括号 ${m[0]}（钉位符应写成 &lt;…&gt;，否则 Telegram 会拒绝发送）`
      );
    }
  }
});

test("渲染：每个 <code> 都必须有配对的 </code>", () => {
  // 上面那条测试只查"有没有非法标签"，而 &lt;/code&gt; 是合法的转义文本，
  // 所以它放过了一次真实故障：闭合标签被误转义后，Telegram 报
  // can't parse entities: Can't find end tag corresponding to start tag "code"
  // 并整条拒收消息，用户侧看到的就是"发命令没反应"。这里补上配对检查。
  for (const [label, text] of [["用户", buildHelp(false)], ["管理员", buildHelp(true)]]) {
    const open = (text.match(/<code>/g) || []).length;
    const close = (text.match(/<\/code>/g) || []).length;
    assert.equal(open, close, `${label}视角的 <code> 与 </code> 不配对（${open} vs ${close}）`);
    assert.ok(open > 0, `${label}视角应至少有一个 <code>`);
  }
});
