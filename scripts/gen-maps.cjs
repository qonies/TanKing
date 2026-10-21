// 13×13 大格模式，行内每字符 ×2、每行 ×2 展开为 26×26 小格
const PATTERNS = {
  环形工事: [
    '.............',
    '.B.........B.',
    '.B..S...S..B.',
    '.............',
    '.............',
    '.....BBB.....',
    '.WW..B.B..WW.',
    '.....BBB.....',
    '.............',
    '.B..T...T..B.',
    '.B.........B.',
    '.I.........I.',
    '.............',
  ],
  四水归堂: [
    '.............',
    '.B..B...B..B.',
    '.B..B...B..B.',
    '......W......',
    '.SS...W...SS.',
    '..B..BBB..B..',
    '..B..B.B..B..',
    '..B..BBB..B..',
    '.SS.......SS.',
    '......W......',
    '.B..B...B..B.',
    '.B..B...B..B.',
    '.............',
  ],
  密林穿梭: [
    '.............',
    '..B.......B..',
    '..B..TTT..B..',
    '.....TTT.....',
    '.B...TTT...B.',
    '.....BBB.....',
    '.TT..B.B..TT.',
    '.....BBB.....',
    '.B...TTT...B.',
    '.....TTT.....',
    '..B..TTT..B..',
    '..B.......B..',
    '.............',
  ],
  冰原对决: [
    '.............',
    '.S.........S.',
    '..B..III..B..',
    '.....III.....',
    '..IIIIIIIII..',
    '.....BBB.....',
    '.I...B.B...I.',
    '.....BBB.....',
    '..IIIIIIIII..',
    '.....III.....',
    '..B..III..B..',
    '.S.........S.',
    '.............',
  ],
  堡垒攻防: [
    '.............',
    'B...........B',
    'B..BBBBBBB..B',
    'B..B.....B..B',
    '....B.S.B....',
    '....BBBBB....',
    '.WW..B.B..WW.',
    '....BBBBB....',
    '....B.S.B....',
    'B..B.....B..B',
    'B..BBBBBBB..B',
    'B...........B',
    '.............',
  ],
};

const CFG = {
  环形工事: { spawns: [[4, 24], [20, 0], [0, 0], [24, 0], [0, 24], [24, 24], [0, 12], [24, 12]], spots: [[4, 8], [20, 8], [4, 16], [20, 16]] },
  四水归堂: { spawns: [[12, 0], [12, 24], [0, 0], [24, 0], [0, 24], [24, 24], [0, 12], [24, 12]], spots: [[0, 12], [24, 12]] },
  密林穿梭: { spawns: [[0, 0], [24, 24], [24, 0], [0, 24], [12, 0], [12, 24], [0, 12], [24, 12]], spots: [[8, 12], [16, 12], [12, 0], [12, 24]] },
  冰原对决: { spawns: [[4, 0], [22, 24], [24, 0], [0, 24], [24, 24], [0, 12], [24, 12], [12, 24]], spots: [[12, 0], [12, 24], [0, 12], [24, 12]] },
  堡垒攻防: { spawns: [[12, 0], [12, 24], [0, 0], [24, 0], [0, 24], [24, 24], [0, 12], [24, 12]], spots: [[0, 12], [24, 12], [12, 6]] },
};

function expand(rows) {
  const out = [];
  for (const r of rows) {
    const doubled = [...r].map((c) => c + c).join('');
    out.push(doubled, doubled);
  }
  return out;
}

const fs = require('fs');
const path = require('path');
const dir = __dirname;

const MAPS_DIR = path.join(dir, '..', 'maps');

// ---- 修补 map01：中心加基地环 + 基地 + 道具点 ----
const m1 = JSON.parse(fs.readFileSync(path.join(MAPS_DIR, 'map01.json'), 'utf-8'));
// 基地环：6×6 小格外圈全部为砖（完整包围 2×2 基地格）
for (let y = 10; y <= 15; y++) {
  const row = [...m1.terrain[y]];
  for (let x = 10; x <= 15; x++) {
    const isBase = (x === 12 || x === 13) && (y === 12 || y === 13);
    if (!isBase) row[x] = 'B';
  }
  m1.terrain[y] = row.join('');
}
// 基地格：清掉覆盖基地 2×2 的树林（基地格必须为空地，否则渲染与碰撞语义冲突）
for (let y = 12; y <= 13; y++) {
  const row = [...m1.terrain[y]];
  row[12] = '.';
  row[13] = '.';
  m1.terrain[y] = row.join('');
}
m1.base = { x: 12, y: 12 };
m1.powerupSpots = [{ x: 4, y: 4 }, { x: 20, y: 4 }, { x: 4, y: 20 }, { x: 20, y: 20 }];
// 出生点补足 8 个（P0 修复：6/8 人开局每人一个独立出生点，不再重叠卡死）
m1.spawns = [
  { x: 4, y: 24 }, { x: 20, y: 0 }, { x: 0, y: 0 }, { x: 24, y: 0 },
  { x: 0, y: 24 }, { x: 24, y: 24 }, { x: 0, y: 12 }, { x: 24, y: 12 },
];
fs.writeFileSync(path.join(MAPS_DIR, 'map01.json'), JSON.stringify(m1, null, 2) + '\n');
console.log('map01.json: patched base ring');

let idx = 2;
for (const [name, pattern] of Object.entries(PATTERNS)) {
  const rows = expand(pattern);
  if (rows.length !== 26 || rows.some((r) => r.length !== 26)) {
    throw new Error(`地图 ${name} 尺寸错误`);
  }
  const cfg = CFG[name];
  // 校验出生点与道具点（小格坐标）为空地（含 32×32 范围）
  for (const [sx, sy] of [...cfg.spawns, ...cfg.spots]) {
    for (let y = sy; y < sy + 2; y++) {
      for (let x = sx; x < sx + 2; x++) {
        if (rows[y][x] !== '.') throw new Error(`地图 ${name} 点位 (${sx},${sy}) 有障碍`);
      }
    }
  }
  const json = {
    name,
    size: 26,
    terrain: rows,
    spawns: cfg.spawns.map(([x, y]) => ({ x, y })),
    base: { x: 12, y: 12 },
    powerupSpots: cfg.spots.map(([x, y]) => ({ x, y })),
  };
  fs.writeFileSync(path.join(MAPS_DIR, `map0${idx}.json`), JSON.stringify(json, null, 2) + '\n');
  console.log(`map0${idx}.json: ${name}`);
  idx++;
}
