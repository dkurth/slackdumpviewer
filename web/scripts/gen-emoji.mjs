// Generates src/emoji-data.json: Slack shortcode -> Unicode string, from
// iamcal's emoji-datasource (the data set Slack's shortcodes come from).
// Skin tones are keyed the way Slack names them: "wave::skin-tone-3".
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const data = JSON.parse(readFileSync(require.resolve('emoji-datasource/emoji.json'), 'utf8'));
const toStr = (u) => String.fromCodePoint(...u.split('-').map((h) => parseInt(h, 16)));
const tones = { '1F3FB': 2, '1F3FC': 3, '1F3FD': 4, '1F3FE': 5, '1F3FF': 6 };
const out = {};
for (const e of data) {
  const s = toStr(e.unified);
  for (const n of e.short_names) out[n] = s;
  if (e.skin_variations) {
    for (const [k, v] of Object.entries(e.skin_variations)) {
      const t = tones[k];
      if (!t) continue; // multi-tone combos
      for (const n of e.short_names) out[`${n}::skin-tone-${t}`] = toStr(v.unified);
    }
  }
}
// Slack-specific aliases not in iamcal
Object.assign(out, { simple_smile: '🙂', thumbsup_all: '👍', squirrel: '🐿️' });
writeFileSync(new URL('../src/emoji-data.json', import.meta.url), JSON.stringify(out));
console.log(`emoji: ${Object.keys(out).length} shortcodes`);
