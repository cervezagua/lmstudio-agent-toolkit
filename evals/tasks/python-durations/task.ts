import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { run } from "../../lib/files";
import { type EvalTask } from "../../lib/task";

// Cases the model never sees: the docstring is the spec, as a user would expect.
const HIDDEN = `
import json
from durations import parse_duration
good = {"1h30m": 5400, "90s": 90, "2h": 7200, "1h 5m 10s": 3910, "45": 45, "0m": 0, "1H30M": 5400, "10m 0s": 600}
bad = ["", "abc", "1d", "5m1h", "1h1h", "-5m", "h", "1.5h"]
out = []
for text, seconds in good.items():
    try:
        got = parse_duration(text)
        if got != seconds:
            out.append(f"{text!r} gave {got!r}, not {seconds}")
    except Exception as error:
        out.append(f"{text!r} raised {type(error).__name__}")
for text in bad:
    try:
        got = parse_duration(text)
        out.append(f"{text!r} gave {got!r} instead of raising ValueError")
    except ValueError:
        pass
    except Exception as error:
        out.append(f"{text!r} raised {type(error).__name__}, not ValueError")
print(json.dumps(out))
`;

const python = process.platform === "win32" ? "python" : "python3";

const task: EvalTask = {
  area: "code",
  prompt: "Implement parse_duration in durations.py. Its docstring says what it should do.",
  async check({ dir }) {
    await writeFile(join(dir, "hidden_check.py"), HIDDEN);
    const result = run(dir, python, ["hidden_check.py"]);
    if (result.code !== 0) return [`durations.py fails to load: ${result.output.trim().split("\n").at(-1)}`];
    const wrong: string[] = JSON.parse(result.output.trim().split("\n").at(-1)!);
    return wrong.length ? [`${wrong.length} of 16 cases wrong: ${wrong.slice(0, 4).join("; ")}`] : [];
  },
};

export default task;
