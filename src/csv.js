// Reads bench measurements from CSV or pasted text. Returns rows in kV, µA,
// m/s and mm. Headers are optional; with none, columns are taken as voltage,
// current, wind speed, gap.

const PATTERNS = {
  V: /^(v|volt|voltage|u_?kv|hv|kv)\b|volt|kv/i,
  I: /^(i|curr|current)\b|curr|amp|µa|ua\b|ma\b/i,
  u: /^(u|w|vel|wind|speed)\b|vel|speed|wind|m\/s|ms\b/i,
  d: /^(d|gap)\b|gap|mm\b/i,
};

function splitLine(line) {
  if (line.includes('\t')) return line.split('\t');
  if (line.includes(';')) return line.split(';');
  if (line.includes(',')) return line.split(',');
  return line.trim().split(/\s+/);
}

export function parseBench(text) {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  if (!lines.length) return { rows: [], error: 'No rows found.' };
  let header = null;
  const first = splitLine(lines[0]).map((s) => s.trim());
  if (first.some((s) => s && Number.isNaN(Number(s)))) {
    header = first;
    lines.shift();
  }
  // Column roles and unit factors.
  const role = { V: 0, I: 1, u: 2, d: 3 };
  const scale = { V: 1, I: 1, u: 1, d: 1 };
  if (header) {
    for (const k of Object.keys(role)) role[k] = -1;
    header.forEach((h, n) => {
      const low = h.toLowerCase();
      // Current first: "I_uA" must not be read as a speed column.
      for (const k of ['I', 'V', 'd', 'u']) {
        if (role[k] === -1 && PATTERNS[k].test(low)) {
          role[k] = n;
          if (k === 'I' && /\bma\b|_ma|\(ma\)/.test(low)) scale.I = 1000;
          if (k === 'I' && /\bna\b|_na|\(na\)/.test(low)) scale.I = 0.001;
          if (k === 'V' && !/kv/.test(low) && /\bv\b|_v\b|\(v\)|volt/.test(low)) scale.V = 0.001;
          if (k === 'd' && /\bcm\b/.test(low)) scale.d = 10;
          break;
        }
      }
    });
    if (role.V < 0 || role.I < 0) {
      return { rows: [], error: 'Could not find voltage and current columns. Name them, for example, V_kV and I_uA.' };
    }
  }
  const rows = [];
  for (const line of lines) {
    const cells = splitLine(line).map((s) => Number(s.trim()));
    const get = (k) => (role[k] >= 0 && role[k] < cells.length ? cells[role[k]] * scale[k] : NaN);
    let V = get('V');
    const I = get('I');
    if (!Number.isFinite(V) || !Number.isFinite(I)) continue;
    // Headerless volts: anything over 100 must be volts, not kilovolts.
    if (!header && V > 100) V /= 1000;
    rows.push({ V, I, u: get('u'), d: get('d') });
  }
  if (!rows.length) return { rows, error: 'No numeric rows with both voltage and current.' };
  return { rows, error: null };
}
