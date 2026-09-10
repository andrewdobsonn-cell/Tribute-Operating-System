/* Every page's inline script must parse.
 *
 * Run: node tests/pages-parse.test.js
 *
 * caregiver_supply_map.html shipped dead for weeks: a restyle put
 *   font-family:'Inter'
 * inside a single-quoted JS string, the whole block failed to parse, and the
 * page sat on "Loading caregiver supply data..." forever. Nothing caught it,
 * because a page that never runs still serves a 200 and still looks like it is
 * working. This is the cheapest possible guard against that whole class.
 */
const fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..');
const dead = [];
let pages = 0, blocks = 0;

for (const f of fs.readdirSync(root).filter(f => f.endsWith('.html'))) {
  pages++;
  const html = fs.readFileSync(path.join(root, f), 'utf8');
  [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].forEach((m, i) => {
    const type = (m[0].match(/type="([^"]+)"/) || [])[1];
    if (type && !/javascript|module/.test(type)) return;   // JSON-LD, templates
    blocks++;
    try { new Function(m[1]); }
    catch (e) { dead.push(f + '  [block ' + i + ']  ' + e.message); }
  });
}

console.log(pages + ' pages, ' + blocks + ' inline script blocks');
if (dead.length) { console.log('\nPAGES THAT CANNOT RUN:\n  ' + dead.join('\n  ')); process.exit(1); }
console.log('all parse');
