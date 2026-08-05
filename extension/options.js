// options.js — classic script; loaded after src/patterns.js and src/storage.js (both attach to globalThis.QS)
const listEl = document.getElementById("pattern-list");
const inputEl = document.getElementById("pattern-input");
const addBtn = document.getElementById("add-btn");
const errorEl = document.getElementById("error");

const NATIVE = new Set(QS.storage.NATIVE_PATTERNS);

async function render() {
  try {
    const patterns = await QS.storage.loadPatterns();
    errorEl.textContent = "";
    listEl.innerHTML = "";
    for (const raw of patterns) {
      const row = document.createElement("div");
      row.className = "row";
      const label = document.createElement("span");
      label.textContent = raw + (NATIVE.has(raw) ? " (native)" : "");
      row.appendChild(label);
      if (!NATIVE.has(raw)) {
        const up = document.createElement("button"); up.textContent = "↑";
        up.onclick = async () => { await move(raw, -1); };
        const down = document.createElement("button"); down.textContent = "↓";
        down.onclick = async () => { await move(raw, 1); };
        const del = document.createElement("button"); del.textContent = "✕";
        del.onclick = async () => { await removePattern(raw); };
        row.append(up, down, del);
      }
      listEl.appendChild(row);
    }
  } catch (err) {
    errorEl.textContent = "Failed to load patterns: " + err.message;
  }
}

async function move(raw, dir) {
  const patterns = await QS.storage.loadPatterns();
  const i = patterns.indexOf(raw);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= patterns.length) return;
  [patterns[i], patterns[j]] = [patterns[j], patterns[i]];
  await QS.storage.savePatterns(patterns);
  render();
}

async function removePattern(raw) {
  const patterns = (await QS.storage.loadPatterns()).filter((p) => p !== raw);
  await QS.storage.savePatterns(patterns);
  render();
}

addBtn.onclick = async () => {
  const raw = inputEl.value.trim();
  if (!QS.patterns.isValidPattern(raw)) {
    errorEl.textContent = "Invalid pattern — use comma/hyphen separated positive integers (e.g. 4-3-3).";
    return;
  }
  errorEl.textContent = "";
  const patterns = await QS.storage.loadPatterns();
  if (patterns.includes(raw)) {
    errorEl.textContent = `"${raw}" is already in the list.`;
    inputEl.value = "";
    return;
  }
  patterns.push(raw);
  await QS.storage.savePatterns(patterns);
  inputEl.value = "";
  render();
};

// Enter in the input adds the pattern (no form on this page)
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addBtn.onclick();
});

render();
