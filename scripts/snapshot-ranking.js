#!/usr/bin/env node
/**
 * 积分排行榜快照
 *
 * 从云开发控制台导出的原始数据中算出各班各学期的积分排行，脱敏后写成 Markdown 归档，
 * 以便云端数据意外丢失时仍能还原每个人的积分。
 *
 * 用法：
 *   node scripts/snapshot-ranking.js              仅生成快照
 *   node scripts/snapshot-ranking.js --commit     生成后自动 git 提交
 *
 * 原始导出文件放在 backup/raw/（该目录已被 .gitignore 排除，含完整个人信息，切勿提交）：
 *   students.json      必需
 *   scoreRecords.json  必需
 *   semesters.json     可选，用于按学期分组并显示学期名
 *
 * 脱敏规则：姓名只留姓氏（张**），标识只留学号或手机号的后 4 位。
 * 同一班内后 4 位基本唯一，教师对照名册即可还原到人，但仓库里看不到完整身份。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const RAW_DIR = path.join(ROOT, 'backup', 'raw');
const OUT_DIR = path.join(ROOT, 'backup', 'ranking');

const SCORE_TYPE_LABELS = {
  attendance: '考勤',
  homework: '课堂',
  exam: '作业',
  activity: '活动',
  other: '其他',
};
const SCORE_TYPES = Object.keys(SCORE_TYPE_LABELS);

// 晚修加分单独统计、不计入总分，与云函数的判定保持一致
function isNightBonus(r) {
  return r.scoreType === 'attendance' && r.session === 'night';
}

// 云开发导出的是 JSON Lines（每行一个文档），这里也兼容普通 JSON 数组
function readDocs(name, required) {
  const file = path.join(RAW_DIR, name);
  if (!fs.existsSync(file)) {
    if (required) {
      console.error('缺少必需的导出文件：' + path.relative(ROOT, file));
      console.error('请先在云开发控制台导出该集合，见 backup/README.md');
      process.exit(1);
    }
    return [];
  }
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  if (text[0] === '[') return JSON.parse(text);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (e) {
        console.error(`${name} 第 ${i + 1} 行不是合法 JSON，已跳过`);
        return null;
      }
    })
    .filter(Boolean);
}

// 姓名只保留姓氏；星号数固定，避免泄漏名字长度
function maskName(name) {
  const s = String(name || '').trim();
  if (!s) return '（无名）';
  return s[0] + '**';
}

// 学号或手机号只保留后 4 位，够教师对照名册区分同姓的人
function maskKey(key) {
  const s = String(key || '').trim();
  if (s.length <= 4) return s;
  return '…' + s.slice(-4);
}

// 一组记录覆盖的北京日期区间，用于标注学期并在缺少学期名时兜底
function dayRange(records) {
  const days = records.map((r) => r.day).filter(Boolean).sort();
  if (!days.length) return null;
  return { from: days[0], to: days[days.length - 1] };
}

function today() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 按北京时间
  return d.toISOString().slice(0, 10);
}

function buildRanking(students, records) {
  const totals = {};
  const byType = {};
  const nightTotals = {};
  for (const r of records) {
    const id = r.studentId;
    if (isNightBonus(r)) {
      nightTotals[id] = (nightTotals[id] || 0) + (Number(r.score) || 0);
      continue;
    }
    totals[id] = (totals[id] || 0) + (Number(r.score) || 0);
    if (!byType[id]) byType[id] = {};
    byType[id][r.scoreType] = (byType[id][r.scoreType] || 0) + (Number(r.score) || 0);
  }
  return students
    .map((s) => ({
      name: maskName(s.name),
      key: maskKey(s.studentId),
      total: totals[s.studentId] || 0,
      night: nightTotals[s.studentId] || 0,
      types: byType[s.studentId] || {},
    }))
    .sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));
}

function renderTable(ranking) {
  const header =
    '| 名次 | 姓名 | 标识 | ' + SCORE_TYPES.map((t) => SCORE_TYPE_LABELS[t]).join(' | ') + ' | 总分 | 晚修 |';
  const divider =
    '| ---: | --- | --- |' + SCORE_TYPES.map(() => ' ---: |').join('') + ' ---: | ---: |';
  const rows = ranking.map((r, i) => {
    const cells = SCORE_TYPES.map((t) => r.types[t] || 0);
    return `| ${i + 1} | ${r.name} | ${r.key} | ${cells.join(' | ')} | **${r.total}** | ${r.night} |`;
  });
  return [header, divider, ...rows].join('\n');
}

function main() {
  const students = readDocs('students.json', true);
  const records = readDocs('scoreRecords.json', true);
  const semesters = readDocs('semesters.json', false);
  if (!semesters.length) {
    console.warn('未找到 semesters.json，学期名将以日期区间代替。建议一并导出该集合。');
  }

  const semesterName = {};
  for (const s of semesters) semesterName[s._id] = s.name;

  // 按班级 → 学期分组；缺少学期导出时统一归到「全部学期」
  const classes = [...new Set(students.map((s) => s.className || '未分班'))].sort();
  const stamp = today();

  const lines = [
    `# 积分排行榜快照 · ${stamp}`,
    '',
    `> 由云开发导出数据生成，姓名与标识已脱敏。共 ${students.length} 名学生、${records.length} 条积分记录。`,
    '',
  ];

  let sections = 0;
  for (const className of classes) {
    const classStudents = students.filter((s) => (s.className || '未分班') === className);
    const ids = new Set(classStudents.map((s) => s.studentId));
    const classRecords = records.filter((r) => ids.has(r.studentId));

    const semesterIds = [...new Set(classRecords.map((r) => r.semesterId || null))];
    // 学期按名称排序，没有学期归属的排最后
    semesterIds.sort((a, b) => {
      const na = semesterName[a] || '';
      const nb = semesterName[b] || '';
      if (!na) return 1;
      if (!nb) return -1;
      return na < nb ? -1 : 1;
    });

    lines.push(`## ${className}`, '');
    if (!classRecords.length) {
      lines.push('_本班暂无积分记录_', '');
      sections++;
      continue;
    }

    for (const sid of semesterIds) {
      const subset = classRecords.filter((r) => (r.semesterId || null) === sid);
      const ranking = buildRanking(classStudents, subset);
      const total = ranking.reduce((n, r) => n + r.total, 0);
      const nightTotal = ranking.reduce((n, r) => n + r.night, 0);
      const range = dayRange(subset);

      // 没导出 semesters.json 时用记录的日期区间兜底，否则多个学期会都叫「未知学期」而无法区分
      let label = semesterName[sid];
      if (!label) {
        label = sid ? '未知学期' : '未归属学期';
        if (range) label += `（${range.from} 至 ${range.to}）`;
      }

      const meta =
        `记录 ${subset.length} 条，合计 ${total} 分` +
        (nightTotal ? `，另有晚修加分 ${nightTotal} 分（不计入合计）` : '') +
        (range ? `，覆盖 ${range.from} 至 ${range.to}` : '') +
        '。';

      lines.push(`### ${label}`, '', meta, '', renderTable(ranking), '');
      sections++;
    }
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, stamp + '.md');
  fs.writeFileSync(outFile, lines.join('\n'), 'utf8');

  const rel = path.relative(ROOT, outFile).replace(/\\/g, '/');
  console.log(`已生成 ${rel}`);
  console.log(`  班级 ${classes.length} 个，榜单 ${sections} 份，学生 ${students.length} 名`);

  if (process.argv.includes('--commit')) {
    try {
      execFileSync('git', ['add', rel], { cwd: ROOT, stdio: 'pipe' });
      const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim();
      if (!staged) {
        console.log('  内容与上次快照相同，无需提交');
        return;
      }
      execFileSync('git', ['commit', '-q', '-m', `积分排行榜快照 ${stamp}`], {
        cwd: ROOT,
        stdio: 'pipe',
      });
      console.log('  已提交，执行 git push 推送到远端');
    } catch (e) {
      console.error('  自动提交失败：' + (e.stderr ? e.stderr.toString().trim() : e.message));
      console.error('  文件已生成，可手动 git add / commit');
    }
  }
}

main();
