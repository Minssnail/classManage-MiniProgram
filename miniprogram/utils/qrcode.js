/**
 * 轻量二维码编码器（字节模式 / 纠错等级 L / 版本 1~9）
 *
 * 小程序端不引入 npm 依赖，这里内置一份纯 JS 的 QR 编码实现，
 * 只负责把字符串编码成布尔矩阵，绘制交给调用方（见 pages/attendance）。
 * 考勤二维码的载荷是 "CLASSMANAGE_ATT:<32位token>" 约 48 字节，版本 3 即可容纳。
 */

// ---------- 伽罗华域 GF(256)，本原多项式 0x11D ----------
const EXP_TABLE = new Array(256);
const LOG_TABLE = new Array(256);
for (let i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
for (let i = 8; i < 256; i++) {
  EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
}
for (let i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;

function gexp(n) {
  while (n < 0) n += 255;
  while (n >= 256) n -= 255;
  return EXP_TABLE[n];
}

function glog(n) {
  if (n < 1) throw new Error('glog(' + n + ')');
  return LOG_TABLE[n];
}

// 多项式乘法（系数为 GF(256) 元素）
function polyMultiply(a, b) {
  const num = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      num[i + j] ^= gexp(glog(a[i]) + glog(b[j]));
    }
  }
  return trimPoly(num);
}

// 多项式取模，用于计算 RS 纠错码
function polyMod(a, e) {
  if (a.length - e.length < 0) return a;
  const ratio = glog(a[0]) - glog(e[0]);
  const num = a.slice();
  for (let i = 0; i < e.length; i++) {
    num[i] ^= gexp(glog(e[i]) + ratio);
  }
  return polyMod(trimPoly(num), e);
}

function trimPoly(num) {
  let offset = 0;
  while (offset < num.length && num[offset] === 0) offset++;
  return num.slice(offset);
}

// 生成 ecLength 次纠错生成多项式
function errorCorrectPolynomial(ecLength) {
  let a = [1];
  for (let i = 0; i < ecLength; i++) a = polyMultiply(a, [1, gexp(i)]);
  return a;
}

// ---------- 版本参数表（仅纠错等级 L） ----------
// 每项为 [块数, 块总码字数, 块数据码字数]
const RS_BLOCKS_L = {
  1: [1, 26, 19],
  2: [1, 44, 34],
  3: [1, 70, 55],
  4: [1, 100, 80],
  5: [1, 134, 108],
  6: [2, 86, 68],
  7: [2, 98, 78],
  8: [2, 121, 97],
  9: [2, 146, 116],
};

// 各版本对齐图案中心坐标
const ALIGN_PATTERNS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
};

const MAX_VERSION = 9;

function rsBlocks(version) {
  const table = RS_BLOCKS_L[version];
  const list = [];
  for (let i = 0; i < table.length; i += 3) {
    const count = table[i];
    const totalCount = table[i + 1];
    const dataCount = table[i + 2];
    for (let j = 0; j < count; j++) list.push({ totalCount, dataCount });
  }
  return list;
}

function totalDataCount(version) {
  return rsBlocks(version).reduce((sum, b) => sum + b.dataCount, 0);
}

// ---------- BCH 校验（格式信息 / 版本信息） ----------
const G15 = 0x537;
const G15_MASK = 0x5412;
const G18 = 0x1f25;

function bchDigit(data) {
  let digit = 0;
  while (data !== 0) {
    digit++;
    data >>>= 1;
  }
  return digit;
}

function bchTypeInfo(data) {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) {
    d ^= G15 << (bchDigit(d) - bchDigit(G15));
  }
  return ((data << 10) | d) ^ G15_MASK;
}

function bchTypeNumber(data) {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) {
    d ^= G18 << (bchDigit(d) - bchDigit(G18));
  }
  return (data << 12) | d;
}

// ---------- 掩码 ----------
function maskFn(pattern, i, j) {
  switch (pattern) {
    case 0: return (i + j) % 2 === 0;
    case 1: return i % 2 === 0;
    case 2: return j % 3 === 0;
    case 3: return (i + j) % 3 === 0;
    case 4: return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    case 5: return ((i * j) % 2) + ((i * j) % 3) === 0;
    case 6: return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    case 7: return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
    default: throw new Error('bad mask:' + pattern);
  }
}

// ---------- 比特缓冲 ----------
function createBitBuffer() {
  return {
    buffer: [],
    length: 0,
    put(num, len) {
      for (let i = 0; i < len; i++) this.putBit(((num >>> (len - i - 1)) & 1) === 1);
    },
    putBit(bit) {
      const bufIndex = Math.floor(this.length / 8);
      if (this.buffer.length <= bufIndex) this.buffer.push(0);
      if (bit) this.buffer[bufIndex] |= 0x80 >>> (this.length % 8);
      this.length++;
    },
  };
}

// UTF-8 编码（二维码字节模式按字节写入，中文同样可编）
function utf8Bytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return bytes;
}

const PAD0 = 0xec;
const PAD1 = 0x11;

// 数据码字：模式指示符 + 字符计数 + 数据 + 结束符 + 填充
function createData(version, bytes) {
  const buffer = createBitBuffer();
  buffer.put(4, 4); // 字节模式
  buffer.put(bytes.length, 8); // 版本 1~9 的字节模式计数位长为 8
  for (let i = 0; i < bytes.length; i++) buffer.put(bytes[i], 8);

  const totalBits = totalDataCount(version) * 8;
  if (buffer.length > totalBits) {
    throw new Error('数据超出二维码容量：' + buffer.length + ' > ' + totalBits);
  }
  if (buffer.length + 4 <= totalBits) buffer.put(0, 4);
  while (buffer.length % 8 !== 0) buffer.putBit(false);
  while (buffer.length < totalBits) {
    buffer.put(PAD0, 8);
    if (buffer.length >= totalBits) break;
    buffer.put(PAD1, 8);
  }
  return buffer.buffer;
}

// 分块计算纠错码并交织
function createBytes(version, dataBytes) {
  const blocks = rsBlocks(version);
  let offset = 0;
  let maxDcCount = 0;
  let maxEcCount = 0;
  const dcData = [];
  const ecData = [];

  for (const block of blocks) {
    const dcCount = block.dataCount;
    const ecCount = block.totalCount - dcCount;
    maxDcCount = Math.max(maxDcCount, dcCount);
    maxEcCount = Math.max(maxEcCount, ecCount);

    const dc = dataBytes.slice(offset, offset + dcCount);
    offset += dcCount;
    dcData.push(dc);

    const rsPoly = errorCorrectPolynomial(ecCount);
    const rawPoly = dc.concat(new Array(rsPoly.length - 1).fill(0));
    const modPoly = polyMod(rawPoly, rsPoly);
    const ec = new Array(rsPoly.length - 1).fill(0);
    for (let i = 0; i < ec.length; i++) {
      const modIndex = i + modPoly.length - ec.length;
      ec[i] = modIndex >= 0 ? modPoly[modIndex] : 0;
    }
    ecData.push(ec);
  }

  const result = [];
  for (let i = 0; i < maxDcCount; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < dcData[b].length) result.push(dcData[b][i]);
    }
  }
  for (let i = 0; i < maxEcCount; i++) {
    for (let b = 0; b < blocks.length; b++) {
      if (i < ecData[b].length) result.push(ecData[b][i]);
    }
  }
  return result;
}

// ---------- 矩阵构建 ----------
function makeMatrix(version, maskPattern, data) {
  const size = version * 4 + 17;
  const modules = [];
  for (let r = 0; r < size; r++) modules.push(new Array(size).fill(null));

  setupProbePattern(modules, size, 0, 0);
  setupProbePattern(modules, size, size - 7, 0);
  setupProbePattern(modules, size, 0, size - 7);
  setupAlignPatterns(modules, version);
  setupTimingPattern(modules, size);
  setupTypeInfo(modules, size, maskPattern);
  if (version >= 7) setupTypeNumber(modules, size, version);
  mapData(modules, size, data, maskPattern);
  return modules.map((row) => row.map((cell) => cell === true));
}

function setupProbePattern(modules, size, row, col) {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      if (row + r < 0 || row + r >= size || col + c < 0 || col + c >= size) continue;
      const dark =
        (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
        (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
        (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      modules[row + r][col + c] = dark;
    }
  }
}

function setupAlignPatterns(modules, version) {
  const pos = ALIGN_PATTERNS[version];
  for (const row of pos) {
    for (const col of pos) {
      if (modules[row][col] !== null) continue; // 与定位图案重叠处跳过
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          modules[row + r][col + c] =
            r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
        }
      }
    }
  }
}

function setupTimingPattern(modules, size) {
  for (let i = 8; i < size - 8; i++) {
    if (modules[i][6] === null) modules[i][6] = i % 2 === 0;
    if (modules[6][i] === null) modules[6][i] = i % 2 === 0;
  }
}

function setupTypeInfo(modules, size, maskPattern) {
  // 纠错等级 L 的两位标识为 01
  const bits = bchTypeInfo((1 << 3) | maskPattern);
  for (let i = 0; i < 15; i++) {
    const mod = ((bits >> i) & 1) === 1;
    // 左上角竖向 + 左下角
    if (i < 6) modules[i][8] = mod;
    else if (i < 8) modules[i + 1][8] = mod;
    else modules[size - 15 + i][8] = mod;
    // 左上角横向 + 右上角
    if (i < 8) modules[8][size - i - 1] = mod;
    else if (i < 9) modules[8][15 - i - 1 + 1] = mod;
    else modules[8][15 - i - 1] = mod;
  }
  modules[size - 8][8] = true; // 固定的暗模块
}

function setupTypeNumber(modules, size, version) {
  const bits = bchTypeNumber(version);
  for (let i = 0; i < 18; i++) {
    const mod = ((bits >> i) & 1) === 1;
    modules[Math.floor(i / 3)][(i % 3) + size - 8 - 3] = mod;
    modules[(i % 3) + size - 8 - 3][Math.floor(i / 3)] = mod;
  }
}

// 按 Z 字形从右下角向上铺设数据位并应用掩码
function mapData(modules, size, data, maskPattern) {
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;

  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--; // 跳过竖向定时图案所在列
    for (;;) {
      for (let c = 0; c < 2; c++) {
        if (modules[row][col - c] === null) {
          let dark = false;
          if (byteIndex < data.length) {
            dark = ((data[byteIndex] >>> bitIndex) & 1) === 1;
          }
          if (maskFn(maskPattern, row, col - c)) dark = !dark;
          modules[row][col - c] = dark;
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || size <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}

// ---------- 掩码惩罚评分（ISO/IEC 18004 四条规则） ----------
function lostPoint(modules) {
  const size = modules.length;
  let lost = 0;

  // 规则1：行/列中连续 5 个及以上同色模块，罚分 3 + (长度 - 5)
  for (let i = 0; i < size; i++) {
    let rowRun = 1;
    let colRun = 1;
    for (let j = 1; j < size; j++) {
      if (modules[i][j] === modules[i][j - 1]) {
        rowRun++;
      } else {
        if (rowRun >= 5) lost += 3 + rowRun - 5;
        rowRun = 1;
      }
      if (modules[j][i] === modules[j - 1][i]) {
        colRun++;
      } else {
        if (colRun >= 5) lost += 3 + colRun - 5;
        colRun = 1;
      }
    }
    if (rowRun >= 5) lost += 3 + rowRun - 5;
    if (colRun >= 5) lost += 3 + colRun - 5;
  }

  // 规则2：2x2 同色方块
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      let count = 0;
      if (modules[row][col]) count++;
      if (modules[row + 1][col]) count++;
      if (modules[row][col + 1]) count++;
      if (modules[row + 1][col + 1]) count++;
      if (count === 0 || count === 4) lost += 3;
    }
  }

  // 规则3：出现 1:1:3:1:1 定位图案样式且一侧带 4 个浅色模块，罚分 40
  const P1 = [true, false, true, true, true, false, true, false, false, false, false]; // 10111010000
  const P2 = [false, false, false, false, true, false, true, true, true, false, true]; // 00001011101
  const matches = (get) => {
    let hit1 = true;
    let hit2 = true;
    for (let k = 0; k < 11; k++) {
      const v = get(k);
      if (v !== P1[k]) hit1 = false;
      if (v !== P2[k]) hit2 = false;
      if (!hit1 && !hit2) return false;
    }
    return true;
  };
  for (let i = 0; i < size; i++) {
    for (let j = 0; j <= size - 11; j++) {
      if (matches((k) => modules[i][j + k])) lost += 40;
      if (matches((k) => modules[j + k][i])) lost += 40;
    }
  }

  // 规则4：黑白比例偏离 50%
  let darkCount = 0;
  for (let col = 0; col < size; col++) {
    for (let row = 0; row < size; row++) {
      if (modules[row][col]) darkCount++;
    }
  }
  const ratio = Math.abs((100 * darkCount) / (size * size) - 50) / 5;
  lost += Math.floor(ratio) * 10;
  return lost;
}

/**
 * 把文本编码为二维码模块矩阵。
 * @param {string} text 待编码文本
 * @returns {{size:number, modules:boolean[][], version:number}}
 */
function encode(text) {
  const bytes = utf8Bytes(String(text));
  let version = 0;
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (bytes.length + 2 <= totalDataCount(v)) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error('内容过长，超出二维码版本 9 的容量');

  const data = createBytes(version, createData(version, bytes));

  let best = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const modules = makeMatrix(version, mask, data);
    const score = lostPoint(modules);
    if (score < bestScore) {
      bestScore = score;
      best = modules;
    }
  }
  return { size: best.length, modules: best, version };
}

/**
 * 在 Canvas 2D 上下文中绘制二维码。
 * @param {CanvasRenderingContext2D} ctx Canvas 2D 上下文
 * @param {string} text 待编码文本
 * @param {number} pixelSize 画布边长（px）
 * @param {object} [options] { dark, light, padding } padding 单位为模块数，默认 2
 */
function draw(ctx, text, pixelSize, options) {
  const opts = options || {};
  const dark = opts.dark || '#000000';
  const light = opts.light || '#ffffff';
  const padding = opts.padding === undefined ? 2 : opts.padding;

  const result = encode(text);
  const size = result.size;
  const modules = result.modules;
  const scale = pixelSize / (size + padding * 2);

  ctx.fillStyle = light;
  ctx.fillRect(0, 0, pixelSize, pixelSize);
  ctx.fillStyle = dark;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!modules[row][col]) continue;
      // 逐格取整并向上取整边长，避免缩放后模块之间出现缝隙
      const x = Math.round((col + padding) * scale);
      const y = Math.round((row + padding) * scale);
      ctx.fillRect(x, y, Math.ceil(scale), Math.ceil(scale));
    }
  }
  return result;
}

module.exports = { encode, draw };
