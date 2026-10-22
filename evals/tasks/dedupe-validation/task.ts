import { execFileSync } from "node:child_process";
import { listFiles, read } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

// Both validators must behave exactly as before, so they are run on the same inputs as the originals.
const CHECK = `
const { validateSignup } = require("./src/signup");
const { validateInvite } = require("./src/invite");
const emails = ["", "  Ada@Example.com ", "ada@example", "a b@example.com", "x@y.io", "@example.com", "a".repeat(250) + "@example.com", "ADA@EXAMPLE.COM"];
const out = [];
for (const email of emails) {
  out.push(validateSignup({ email, password: "long enough pw" }).join("|"));
  out.push(validateSignup({ email, password: "short" }).join("|"));
  out.push(validateInvite({ email, role: "admin" }).join("|"));
  out.push(validateInvite({ email, role: "owner" }).join("|"));
}
console.log(JSON.stringify(out));
`;

const EXPECTED = (() => {
  const signup = (email: string, password: string) => {
    const p: string[] = [];
    const e = email.trim().toLowerCase();
    if (!e) p.push("email is required");
    else if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e)) p.push("email is not valid");
    if (password.length < 10) p.push("password must be at least 10 characters");
    return p.join("|");
  };
  const invite = (email: string, role: string) => {
    const p = signup(email, "long enough pw").split("|").filter(Boolean);
    if (!["member", "admin"].includes(role)) p.push("role must be member or admin");
    return p.join("|");
  };
  const emails = ["", "  Ada@Example.com ", "ada@example", "a b@example.com", "x@y.io", "@example.com", "a".repeat(250) + "@example.com", "ADA@EXAMPLE.COM"];
  return emails.flatMap(e => [signup(e, "long enough pw"), signup(e, "short"), invite(e, "admin"), invite(e, "owner")]);
})();

const task: EvalTask = {
  area: "code",
  prompt:
    "signup.js and invite.js both check email addresses with the same copy-pasted code. Move that check into one " +
    "shared function and use it from both. Their behaviour must not change.",
  async check({ dir }) {
    const problems: string[] = [];
    let copies = 0;
    for (const file of (await listFiles(dir)).filter(f => f.endsWith(".js"))) {
      copies += ((await read(dir, file)) ?? "").split("[^\\s@]+@[^\\s@]+").length - 1;
    }
    // At most once: a shared function may build the same pattern another way, and then it is not found at all.
    if (copies > 1) problems.push(`the email pattern still appears ${copies} times`);
    try {
      const got: string[] = JSON.parse(execFileSync(process.execPath, ["-e", CHECK], { cwd: dir, encoding: "utf-8", stdio: "pipe", timeout: 30_000 }));
      const changed = got.filter((g, i) => g !== EXPECTED[i]).length;
      if (changed) problems.push(`${changed} of ${EXPECTED.length} validation results changed`);
    } catch (error: any) {
      problems.push(`the validators fail to load: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
    }
    return problems;
  },
};

export default task;
