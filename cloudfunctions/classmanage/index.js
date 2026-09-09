/**
 * 班级积分管理系统 —— 统一业务云函数
 *
 * 小程序端不直接读写数据库，所有业务都经由本云函数，
 * 身份以微信 OPENID 为准（无法伪造），角色与权限在服务端校验。
 *
 * 调用约定：wx.cloud.callFunction({ name: 'classmanage', data: { action, ...payload } })
 * 返回约定：{ ok: true, data } 或 { ok: false, error: '错误信息' }
 */
const cloud = require('wx-server-sdk');
const crypto = require('crypto');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = [
  'users',
  'students',
  'classes',
  'semesters',
  'scoreRecords',
  'rewards',
  'attendanceCodes',
  'majors',
  'courses',
  'examScores',
  'retakeSelections',
];

const SCORE_TYPES = ['attendance', 'homework', 'exam', 'activity', 'other'];
const REWARD_TYPES = ['一等奖', '二等奖', '三等奖'];
const CERTIFICATE_IMAGES = {
  一等奖: '/images/certificates/certificate_001.jpg',
  二等奖: '/images/certificates/certificate_002.jpg',
  三等奖: '/images/certificates/certificate_003.jpg',
};

/**
 * 考勤场次：白天面授课与晚修各算一次，同一天两次互不影响。
 * 升级前的记录没有 session 字段，一律按面授处理，因此 'day' 必须是默认值。
 */
const ATTENDANCE_SESSIONS = ['day', 'night'];
const SESSION_LABELS = { day: '面授课', night: '晚修' };
const DEFAULT_SESSION = 'day';

function normalizeSession(value) {
  const v = String(value || '').trim();
  if (!v) return DEFAULT_SESSION;
  if (ATTENDANCE_SESSIONS.indexOf(v) < 0) fail('考勤场次无效');
  return v;
}

// 考勤码有效期（秒）：默认 60 秒，可在 15~600 秒之间调整
const DEFAULT_CODE_TTL = 60;
const MIN_CODE_TTL = 15;
const MAX_CODE_TTL = 600;
const QR_PREFIX = 'CLASSMANAGE_ATT:';

// ============================================================
// 通用工具
// ============================================================

class BizError extends Error {}

function fail(message) {
  throw new BizError(message);
}

const BEIJING_OFFSET = 8 * 60 * 60 * 1000;

// 云函数运行在 UTC，统一按北京时间计算“今天”
function beijingDay(date) {
  const d = date || new Date();
  return new Date(d.getTime() + BEIJING_OFFSET).toISOString().slice(0, 10);
}

function shiftDay(dayStr, delta) {
  const d = new Date(dayStr + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// 集合可能在旧环境里尚未创建，按需补建（已存在时静默忽略）
async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (e) {
    // 集合已存在
  }
}

// 云数据库单次查询最多 1000 条，这里分页取全量
async function fetchAll(query, pageSize = 1000, maxRecords = 20000) {
  const result = [];
  for (let skip = 0; skip < maxRecords; skip += pageSize) {
    const res = await query.skip(skip).limit(pageSize).get();
    result.push(...res.data);
    if (res.data.length < pageSize) break;
  }
  return result;
}

function hashPassword(password, salt) {
  const useSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(String(password), useSalt, 10000, 32, 'sha256').toString('hex');
  return { salt: useSalt, hash };
}

function verifyPassword(password, salt, hash) {
  const computed = hashPassword(password, salt).hash;
  // 定长比较，避免时序侧信道
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(String(hash || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(user, student) {
  if (!user) return null;
  return {
    _id: user._id,
    username: user.username,
    role: user.role,
    studentId: user.studentId || null,
    name: student ? student.name : null,
    className: student ? student.className || null : null,
    phone: student ? student.phone || null : user.phone || null,
    // 新生入学时尚未分配学号，此前用手机号占位
    studentIdAssigned: student ? student.studentIdAssigned !== false : true,
    createdAt: user.createdAt,
  };
}

// ============================================================
// 身份与权限
// ============================================================

async function getCurrentUser(openid) {
  if (!openid) return null;
  try {
    const res = await db.collection('users').where({ openid }).limit(1).get();
    return res.data[0] || null;
  } catch (e) {
    // 全新环境里 users 集合尚未创建，此时视为未登录，让 system.init 能正常执行
    return null;
  }
}

function requireLogin(user) {
  if (!user) fail('请先登录');
  return user;
}

function requireTeacher(user) {
  requireLogin(user);
  if (user.role !== 'teacher') fail('需要教师权限');
  return user;
}

// ============================================================
// 学期
// ============================================================

// 按当前日期定位所在学期（未存档且区间覆盖今天，取最近开始的）
async function findSemesterByDate(day) {
  const today = day || beijingDay();
  const list = await fetchAll(db.collection('semesters').where({ isArchived: _.neq(true) }));
  const covering = list.filter((s) => s.startDate <= today && today <= s.endDate);
  covering.sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
  return covering[0] || null;
}

async function resolveCurrentSemester() {
  const byDate = await findSemesterByDate();
  if (byDate) return byDate;
  const res = await db.collection('semesters').where({ isCurrent: true }).limit(1).get();
  return res.data[0] || null;
}

// 把 isCurrent 标记与“按日期所在学期”对齐，修复存档学期仍被标记为当前之类的脏数据
async function syncCurrentSemesterFlag() {
  const target = await findSemesterByDate();
  if (!target) return;
  const flagged = await db.collection('semesters').where({ isCurrent: true }).get();
  if (flagged.data.length === 1 && flagged.data[0]._id === target._id) return;
  for (const s of flagged.data) {
    await db.collection('semesters').doc(s._id).update({ data: { isCurrent: false } });
  }
  await db.collection('semesters').doc(target._id).update({ data: { isCurrent: true } });
}

async function currentSemesterId() {
  const semester = await resolveCurrentSemester();
  return semester ? semester._id : null;
}

// ============================================================
// 数据装配
// ============================================================

async function studentMap() {
  const students = await fetchAll(db.collection('students'));
  const map = {};
  for (const s of students) map[s.studentId] = s;
  return map;
}

async function semesterMap() {
  const semesters = await fetchAll(db.collection('semesters'));
  const map = {};
  for (const s of semesters) map[s._id] = s;
  return map;
}

function decorate(records, students, semesters) {
  return records.map((r) => ({
    ...r,
    studentName: students[r.studentId] ? students[r.studentId].name : null,
    className: students[r.studentId] ? students[r.studentId].className : null,
    semesterName: semesters[r.semesterId] ? semesters[r.semesterId].name : null,
  }));
}

// ============================================================
// 班级作用域
// ============================================================

/**
 * 解析本次请求生效的班级。
 * 学生强制锁定在自己所在班级，无法查看其他班级的数据；
 * 教师可用 className 指定班级，不传则表示全部班级。
 */
async function resolveClassName(user, payload) {
  if (user.role === 'student') {
    const students = await studentMap();
    const me = students[user.studentId];
    return me ? me.className || null : null;
  }
  const name = String((payload && payload.className) || '').trim();
  return name || null;
}

// 指定班级的学号集合；className 为空表示不限班级
async function classStudentIds(className) {
  if (!className) return null;
  const students = await fetchAll(db.collection('students').where({ className }));
  return new Set(students.map((s) => s.studentId));
}

/**
 * 构建一次查询的作用域判定：既限定班级，也限定在该班入学之后。
 * 入学之前的记录（例如转班学生在原班的旧记录）不计入本班视图。
 */
async function buildScope(user, payload) {
  const className = await resolveClassName(user, payload);
  const [cls, ids] = await Promise.all([getClassDoc(className), classStudentIds(className)]);
  const startDate = cls && cls.startDate ? cls.startDate : null;
  return {
    className,
    startDate,
    match(record) {
      if (ids && !ids.has(record.studentId)) return false;
      if (!startDate) return true;
      const day = record.day || (record.timestamp ? beijingDay(new Date(record.timestamp)) : null);
      return !day || day >= startDate;
    },
  };
}

/**
 * 取班级档案；classes 集合里没有、但确实有学生挂在该班名下时，按需补建。
 * 早期数据的班级只存在于学生记录上，class.list 会把它们列出来，
 * 若这里不补建，改入学学期或专业规则就会报「班级不存在」。
 */
async function getOrCreateClassDoc(className, user) {
  const existing = await getClassDoc(className);
  if (existing) return existing;
  const used = await db.collection('students').where({ className }).count();
  if (!used.total) return null;
  await ensureClass(className, user);
  return getClassDoc(className);
}

// 取班级档案（含入学学期）；班级不存在时返回 null
async function getClassDoc(className) {
  if (!className) return null;
  try {
    const res = await db.collection('classes').where({ name: className }).limit(1).get();
    return res.data[0] || null;
  } catch (e) {
    return null;
  }
}

/**
 * 班级可见的学期：入学之前的学期与该班无关，不应出现在班级视图里。
 * startDate 为空表示不加限制（老班级或未设置入学学期时保持原有行为）。
 */
function semesterVisibleToClass(semester, classStartDate) {
  if (!classStartDate) return true;
  return semester.endDate >= classStartDate;
}

// ============================================================
// 业务动作
// ============================================================

const actions = {};

// ---------- 系统初始化 ----------

/**
 * 初始化用的示例学生：仅为让新环境有可用数据，不是真实名单。
 * 真实学生请用「班级管理 → 导入名册」或「学生管理 → 添加学生」录入，
 * 姓名、学号属于个人信息，不写进代码。
 */
const SEED_STUDENTS = [
  { name: '示例学生一', studentId: '2000000000001', className: '示例班级' },
  { name: '示例学生二', studentId: '2000000000002', className: '示例班级' },
  { name: '示例学生三', studentId: '2000000000003', className: '示例班级' },
];

const SEED_SEMESTERS = [
  { name: '2026年春季学期', startDate: '2026-02-15', endDate: '2026-07-15', isArchived: true },
  { name: '2026年秋季学期', startDate: '2026-09-01', endDate: '2027-01-31', isArchived: false },
];

// 幂等初始化：只补齐缺失的集合与种子数据，不会删除已有数据
actions['system.init'] = async ({ user }) => {
  // 并行建集合：串行 6 次往返容易顶满云函数默认的 3 秒超时
  await Promise.all(
    COLLECTIONS.map((name) =>
      db.createCollection(name).catch(() => {
        // 集合已存在，忽略
      })
    )
  );

  const userCount = await db.collection('users').count();
  // 首次部署（无任何账号）时允许任何人执行引导初始化，之后仅限教师
  if (userCount.total > 0) requireTeacher(user);

  const created = { students: 0, users: 0, semesters: 0 };

  // 先各取一次现有数据做去重，避免逐条 count 造成大量往返而超时
  const [existingSemesters, existingStudents, existingUsers] = await Promise.all([
    fetchAll(db.collection('semesters')),
    fetchAll(db.collection('students')),
    fetchAll(db.collection('users')),
  ]);
  const semesterNames = new Set(existingSemesters.map((s) => s.name));
  const studentIds = new Set(existingStudents.map((s) => s.studentId));
  const usernames = new Set(existingUsers.map((u) => u.username));

  // 教师初始密码随机生成并随结果返回，不在代码里写死
  const teacherPassword = crypto.randomBytes(6).toString('base64url');
  const accounts = [
    { username: 'teacher', password: teacherPassword, role: 'teacher', studentId: null },
    ...SEED_STUDENTS.map((s) => ({
      username: s.studentId,
      password: 'student',
      role: 'student',
      studentId: s.studentId,
    })),
  ];

  const writes = [];
  for (const seed of SEED_SEMESTERS) {
    if (semesterNames.has(seed.name)) continue;
    created.semesters++;
    writes.push(
      db.collection('semesters').add({
        data: { ...seed, isCurrent: false, createdAt: new Date() },
      })
    );
  }
  for (const seed of SEED_STUDENTS) {
    if (studentIds.has(seed.studentId)) continue;
    created.students++;
    writes.push(db.collection('students').add({ data: { ...seed, createdAt: new Date() } }));
  }
  let teacherCreated = false;
  for (const acc of accounts) {
    if (usernames.has(acc.username)) continue;
    if (acc.role === 'teacher') teacherCreated = true;
    created.users++;
    const { salt, hash } = hashPassword(acc.password);
    writes.push(
      db.collection('users').add({
        data: {
          username: acc.username,
          passwordSalt: salt,
          passwordHash: hash,
          role: acc.role,
          studentId: acc.studentId,
          openid: null,
          createdAt: new Date(),
        },
      })
    );
  }

  await Promise.all(writes);
  await syncCurrentSemesterFlag();

  // 把种子学生所在的班级补进 classes 集合，班级视图才能看到它
  const seedClasses = [...new Set(SEED_STUDENTS.map((s) => s.className))];
  await Promise.all(seedClasses.map((name) => ensureClass(name, user)));

  return {
    message: '初始化完成',
    created,
    // 只有本次真正新建了教师账号才返回密码；账号已存在时随机密码没有意义
    teacherAccount: teacherCreated ? { username: 'teacher', password: teacherPassword } : null,
    hint: teacherCreated
      ? '请立即记下教师密码并在登录后修改，此密码只显示这一次。'
      : '教师账号已存在，密码未变更。',
  };
};

// 迁移自 Web 版的数据统一打上来源标记，配合 legacyId 实现可重复执行的导入
const LEGACY_SOURCE = 'classSE';

/**
 * 导入 Web 版历史数据（分批调用）。
 * 学期按名称、学生按学号在服务端解析关联；已导入过的 legacyId 会跳过，
 * 因此重复执行、断点续传都是安全的。
 */
actions['system.importLegacy'] = async ({ user, payload }) => {
  requireTeacher(user);
  const scoreRecords = Array.isArray(payload.scoreRecords) ? payload.scoreRecords : [];
  const rewards = Array.isArray(payload.rewards) ? payload.rewards : [];
  if (!scoreRecords.length && !rewards.length) return { inserted: 0, skipped: 0 };

  const [semesters, students, doneScores, doneRewards] = await Promise.all([
    fetchAll(db.collection('semesters')),
    fetchAll(db.collection('students')),
    fetchAll(db.collection('scoreRecords').where({ legacySource: LEGACY_SOURCE })),
    fetchAll(db.collection('rewards').where({ legacySource: LEGACY_SOURCE })),
  ]);

  const semesterIdByName = {};
  for (const s of semesters) semesterIdByName[s.name] = s._id;
  const knownStudents = new Set(students.map((s) => s.studentId));
  const doneScoreIds = new Set(doneScores.map((r) => r.legacyId));
  const doneRewardIds = new Set(doneRewards.map((r) => r.legacyId));

  const result = { inserted: 0, skipped: 0, unknownStudent: [], unknownSemester: [] };
  const writes = [];

  for (const r of scoreRecords) {
    if (doneScoreIds.has(r.legacyId)) {
      result.skipped++;
      continue;
    }
    if (!knownStudents.has(r.studentId)) {
      result.unknownStudent.push(r.studentId);
      result.skipped++;
      continue;
    }
    const semesterId = r.semesterName ? semesterIdByName[r.semesterName] : null;
    if (r.semesterName && !semesterId) result.unknownSemester.push(r.semesterName);
    result.inserted++;
    writes.push(
      db.collection('scoreRecords').add({
        data: {
          studentId: r.studentId,
          semesterId: semesterId || null,
          scoreType: r.scoreType,
          score: r.score,
          reason: r.reason || '',
          operator: r.operator || 'system',
          timestamp: new Date(r.timestamp),
          day: r.day,
          legacySource: LEGACY_SOURCE,
          legacyId: r.legacyId,
        },
      })
    );
  }

  for (const r of rewards) {
    if (doneRewardIds.has(r.legacyId)) {
      result.skipped++;
      continue;
    }
    if (!knownStudents.has(r.studentId)) {
      result.unknownStudent.push(r.studentId);
      result.skipped++;
      continue;
    }
    const semesterId = r.semesterName ? semesterIdByName[r.semesterName] : null;
    if (r.semesterName && !semesterId) result.unknownSemester.push(r.semesterName);
    result.inserted++;
    writes.push(
      db.collection('rewards').add({
        data: {
          studentId: r.studentId,
          semesterId: semesterId || null,
          rewardType: r.rewardType,
          certificateImage: CERTIFICATE_IMAGES[r.rewardType] || '',
          reason: r.reason || '',
          operator: r.operator || 'system',
          timestamp: new Date(r.timestamp),
          isRedeemed: !!r.isRedeemed,
          redeemedAt: r.redeemedAt ? new Date(r.redeemedAt) : null,
          legacySource: LEGACY_SOURCE,
          legacyId: r.legacyId,
        },
      })
    );
  }

  await Promise.all(writes);
  result.unknownStudent = [...new Set(result.unknownStudent)];
  result.unknownSemester = [...new Set(result.unknownSemester)];
  return result;
};

// 已导入的历史数据条数，用于前端展示导入进度
actions['system.legacyStatus'] = async ({ user }) => {
  requireTeacher(user);
  const [scores, rewards] = await Promise.all([
    db.collection('scoreRecords').where({ legacySource: LEGACY_SOURCE }).count(),
    db.collection('rewards').where({ legacySource: LEGACY_SOURCE }).count(),
  ]);
  return { scoreRecords: scores.total, rewards: rewards.total };
};

// ---------- 认证 ----------

actions['auth.login'] = async ({ payload, openid }) => {
  const account = String(payload.username || payload.account || '').trim();
  const password = String(payload.password || '');
  if (!account || !password) fail('账号和密码不能为空');

  // 账号可以是学号、手机号或教师用户名，三者都能登录同一个账号
  let res = await db.collection('users').where({ username: account }).limit(1).get();
  if (!res.data.length) {
    res = await db.collection('users').where({ phone: account }).limit(1).get();
  }
  const user = res.data[0];
  if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    fail('账号或密码错误');
  }

  // 一个微信号只绑定一个账号：先解绑该 openid 之前绑定的其它账号
  const bound = await db.collection('users').where({ openid }).get();
  for (const other of bound.data) {
    if (other._id !== user._id) {
      await db.collection('users').doc(other._id).update({ data: { openid: null } });
    }
  }
  await db.collection('users').doc(user._id).update({ data: { openid, lastLoginAt: new Date() } });

  const students = await studentMap();
  return { user: publicUser(user, students[user.studentId]) };
};

actions['auth.me'] = async ({ user }) => {
  if (!user) return { user: null };
  const students = await studentMap();
  return { user: publicUser(user, students[user.studentId]) };
};

actions['auth.logout'] = async ({ user }) => {
  if (user) await db.collection('users').doc(user._id).update({ data: { openid: null } });
  return { message: '已退出登录' };
};

actions['auth.changePassword'] = async ({ user, payload }) => {
  requireLogin(user);
  const oldPassword = String(payload.oldPassword || '');
  const newPassword = String(payload.newPassword || '');
  if (!oldPassword || !newPassword) fail('旧密码和新密码不能为空');
  if (newPassword.length < 6) fail('新密码长度不能少于 6 位');
  if (!verifyPassword(oldPassword, user.passwordSalt, user.passwordHash)) fail('旧密码错误');

  const { salt, hash } = hashPassword(newPassword);
  await db.collection('users').doc(user._id).update({
    data: { passwordSalt: salt, passwordHash: hash },
  });
  return { message: '密码修改成功' };
};

// ---------- 学生 ----------

actions['student.list'] = async ({ user, payload }) => {
  requireLogin(user);
  const semesterId = payload.semesterId || (await currentSemesterId());
  const className = await resolveClassName(user, payload);

  const students = await fetchAll(
    className
      ? db.collection('students').where({ className }).orderBy('name', 'asc')
      : db.collection('students').orderBy('className', 'asc')
  );
  const scores = await fetchAll(
    semesterId
      ? db.collection('scoreRecords').where({ semesterId })
      : db.collection('scoreRecords')
  );

  const totals = {};
  for (const record of scores) {
    totals[record.studentId] = (totals[record.studentId] || 0) + record.score;
  }
  const resolver = await buildRuleResolver();
  let majors = [];
  try {
    majors = await fetchAll(db.collection('majors'));
  } catch (e) {
    // majors 集合可能尚未创建
  }
  const majorByRule = {};
  for (const m of majors) majorByRule[m.ruleCode] = m;

  return {
    students: students.map((s) => {
      const rule = resolver.ruleOf(s.studentId);
      return {
        ...s,
        totalScore: totals[s.studentId] || 0,
        studentIdAssigned: s.studentIdAssigned !== false,
        // 学生自己绑定的规则，为空表示沿用班级默认
        ownRuleCode: s.ruleCode || null,
        ruleCode: rule,
        ruleName: majorByRule[rule] ? majorByRule[rule].name + ' ' + majorByRule[rule].enrollTerm : null,
      };
    }),
    semesterId,
    className,
  };
};

const PHONE_RE = /^1[3-9]\d{9}$/;
const STUDENT_INITIAL_PASSWORD = 'student';

/**
 * 新建一名学生并同步开通账号。
 * 学号与手机号至少给一个：新生入学尚未分配学号时用手机号登录，
 * 此时以手机号作为内部关联键占位，并标记 studentIdAssigned=false，
 * 待学号下发后由 student.assignStudentId 换成真实学号。
 */
async function createStudent({ name, studentId, phone, className }) {
  if (!name) fail('姓名不能为空');
  if (!studentId && !phone) fail('学号和手机号至少填一个');
  if (phone && !PHONE_RE.test(phone)) fail('手机号格式不正确：' + phone);

  const key = studentId || phone; // 关联积分/奖励记录的内部键
  const assigned = !!studentId;

  const exists = await db.collection('students').where({ studentId: key }).count();
  if (exists.total) fail((assigned ? '该学号' : '该手机号') + '已存在：' + key);
  if (phone) {
    const phoneUsed = await db.collection('students').where({ phone }).count();
    if (phoneUsed.total) fail('该手机号已被占用：' + phone);
  }

  const student = {
    name,
    studentId: key,
    studentIdAssigned: assigned,
    phone: phone || null,
    className,
    createdAt: new Date(),
  };
  const res = await db.collection('students').add({ data: student });

  // 同步创建学生账号：用户名取学号（无学号时取手机号），手机号同样可登录
  const userExists = await db.collection('users').where({ username: key }).count();
  if (!userExists.total) {
    const { salt, hash } = hashPassword(STUDENT_INITIAL_PASSWORD);
    await db.collection('users').add({
      data: {
        username: key,
        phone: phone || null,
        passwordSalt: salt,
        passwordHash: hash,
        role: 'student',
        studentId: key,
        openid: null,
        createdAt: new Date(),
      },
    });
  }

  return { _id: res._id, ...student, totalScore: 0 };
}

actions['student.add'] = async ({ user, payload }) => {
  requireTeacher(user);
  const className = String(payload.className || '').trim();
  if (!className) fail('请先选择班级');
  const student = await createStudent({
    name: String(payload.name || '').trim(),
    studentId: String(payload.studentId || '').trim(),
    phone: String(payload.phone || '').trim(),
    className,
  });
  await ensureClass(className, user);
  return { student };
};

/**
 * 学号下发后补录：把占位键换成真实学号，
 * 并同步迁移账号与该学生名下的积分、奖励记录，保证历史数据不丢。
 */
actions['student.assignStudentId'] = async ({ user, payload }) => {
  requireTeacher(user);
  const currentKey = String(payload.currentKey || '').trim();
  const studentId = String(payload.studentId || '').trim();
  if (!currentKey || !studentId) fail('缺少学生标识或新学号');
  if (currentKey === studentId) fail('新学号与当前标识相同');

  const res = await db.collection('students').where({ studentId: currentKey }).limit(1).get();
  const student = res.data[0];
  if (!student) fail('学生不存在');
  if (student.studentIdAssigned) fail('该学生已分配学号，如需变更请联系管理员');

  const taken = await db.collection('students').where({ studentId }).count();
  if (taken.total) fail('该学号已被占用：' + studentId);

  await db.collection('students').doc(student._id).update({
    data: { studentId, studentIdAssigned: true },
  });
  // 账号的用户名换成学号，手机号字段保留，两者都能登录
  await db.collection('users').where({ studentId: currentKey }).update({
    data: { username: studentId, studentId },
  });
  await db.collection('scoreRecords').where({ studentId: currentKey }).update({
    data: { studentId },
  });
  await db.collection('rewards').where({ studentId: currentKey }).update({
    data: { studentId },
  });

  return { message: `已为${student.name}分配学号 ${studentId}` };
};

/**
 * 重置学生密码。
 * 学生自行改过密码又忘记时无法自助找回，只能由教师重置。
 * 同时解除微信绑定，学生换手机或账号被别人登录过都能重新用初始密码登入。
 */
actions['student.resetPassword'] = async ({ user, payload }) => {
  requireTeacher(user);
  const account = String(payload.account || payload.studentId || '').trim();
  if (!account) fail('请提供学号或手机号');

  // 学号和手机号都能定位到学生
  let res = await db.collection('students').where({ studentId: account }).limit(1).get();
  if (!res.data.length) {
    res = await db.collection('students').where({ phone: account }).limit(1).get();
  }
  const student = res.data[0];
  if (!student) fail('未找到该学生：' + account);

  const accounts = await db.collection('users').where({ studentId: student.studentId }).get();
  if (!accounts.data.length) fail(`${student.name} 尚未开通账号，请先在学生管理中重新添加`);

  const { salt, hash } = hashPassword(STUDENT_INITIAL_PASSWORD);
  for (const u of accounts.data) {
    await db.collection('users').doc(u._id).update({
      data: { passwordSalt: salt, passwordHash: hash, openid: null },
    });
  }

  return {
    message: `${student.name} 的密码已重置为 ${STUDENT_INITIAL_PASSWORD}`,
    name: student.name,
    loginAccount: accounts.data[0].username,
    initialPassword: STUDENT_INITIAL_PASSWORD,
  };
};

/**
 * 单独指定某名学生适用的专业规则。
 * 同一个班可能有不同入学年份的学生，他们的规则版本不同；
 * 传空则清除单独设置，改为沿用所在班级的默认规则。
 */
actions['student.setRule'] = async ({ user, payload }) => {
  requireTeacher(user);
  const account = String(payload.studentId || payload.account || '').trim();
  const ruleCode = String(payload.ruleCode || '').trim();
  if (!account) fail('请提供学号或手机号');

  let res = await db.collection('students').where({ studentId: account }).limit(1).get();
  if (!res.data.length) {
    res = await db.collection('students').where({ phone: account }).limit(1).get();
  }
  const student = res.data[0];
  if (!student) fail('未找到该学生：' + account);

  let major = null;
  if (ruleCode) {
    const m = await db.collection('majors').where({ ruleCode }).limit(1).get();
    if (!m.data.length) fail('专业规则不存在：' + ruleCode);
    major = m.data[0];
  }
  await db.collection('students').doc(student._id).update({ data: { ruleCode: ruleCode || null } });

  return {
    message: major
      ? `${student.name} 已改用「${major.name} ${major.enrollTerm}」规则`
      : `${student.name} 已恢复为沿用班级默认规则`,
  };
};

// ---------- 班级 ----------

// 保证班级存在于 classes 集合，避免只在学生记录里出现的“隐形班级”
async function ensureClass(className, user, startSemester) {
  if (!className) return null;
  let exists;
  try {
    exists = await db.collection('classes').where({ name: className }).limit(1).get();
  } catch (e) {
    // 旧环境里 classes 集合还不存在
    await ensureCollection('classes');
    exists = { data: [] };
  }
  if (exists.data.length) {
    const doc = exists.data[0];
    // 已存在但还没设过入学学期时补上，便于旧数据平滑升级
    if (startSemester && !doc.startDate) {
      await db.collection('classes').doc(doc._id).update({
        data: { startSemesterId: startSemester._id, startDate: startSemester.startDate },
      });
    }
    return doc._id;
  }
  const res = await db.collection('classes').add({
    data: {
      name: className,
      createdBy: user ? user.username : 'system',
      createdAt: new Date(),
      isArchived: false,
      startSemesterId: startSemester ? startSemester._id : null,
      startDate: startSemester ? startSemester.startDate : null,
    },
  });
  return res._id;
}

actions['class.list'] = async ({ user, payload }) => {
  requireLogin(user);
  let classes = [];
  try {
    classes = await fetchAll(db.collection('classes').orderBy('name', 'asc'));
  } catch (e) {
    await ensureCollection('classes');
  }
  const students = await fetchAll(db.collection('students'));

  const counts = {};
  const pending = {};
  for (const s of students) {
    if (!s.className) continue;
    counts[s.className] = (counts[s.className] || 0) + 1;
    if (s.studentIdAssigned === false) pending[s.className] = (pending[s.className] || 0) + 1;
  }

  const semesters = await semesterMap();
  let majors = [];
  try {
    majors = await fetchAll(db.collection('majors'));
  } catch (e) {
    // majors 集合可能尚未创建
  }
  const majorByRule = {};
  for (const m of majors) majorByRule[m.ruleCode] = m;

  const known = new Set(classes.map((c) => c.name));
  const list = classes.map((c) => ({
    _id: c._id,
    name: c.name,
    isArchived: !!c.isArchived,
    startDate: c.startDate || null,
    startSemesterName:
      c.startSemesterId && semesters[c.startSemesterId] ? semesters[c.startSemesterId].name : null,
    ruleCode: c.ruleCode || null,
    majorName:
      c.ruleCode && majorByRule[c.ruleCode]
        ? majorByRule[c.ruleCode].name + ' ' + majorByRule[c.ruleCode].enrollTerm
        : null,
    studentCount: counts[c.name] || 0,
    pendingStudentId: pending[c.name] || 0,
  }));
  // 早期数据里班级只存在于学生记录上，这里一并列出，避免看不到
  for (const name of Object.keys(counts)) {
    if (known.has(name)) continue;
    list.push({
      _id: null,
      name,
      isArchived: false,
      startDate: null,
      startSemesterName: null,
      ruleCode: null,
      majorName: null,
      studentCount: counts[name],
      pendingStudentId: pending[name] || 0,
    });
  }
  list.sort((a, b) => (a.name < b.name ? -1 : 1));

  // 学生只返回自己所在的班级
  if (user.role === 'student') {
    const myClass = await resolveClassName(user, payload);
    return { classes: list.filter((c) => c.name === myClass) };
  }
  return { classes: list };
};

actions['class.create'] = async ({ user, payload }) => {
  requireTeacher(user);
  const name = String(payload.name || '').trim();
  if (!name) fail('班级名称不能为空');
  const exists = await db.collection('classes').where({ name }).count();
  if (exists.total) fail('该班级已存在');

  // 新建班级默认从当前学期入学，入学之前的学期对该班不可见
  const startSemester = payload.startSemesterId
    ? (await db.collection('semesters').doc(payload.startSemesterId).get()).data
    : await resolveCurrentSemester();
  const _id = await ensureClass(name, user, startSemester);
  return {
    class: {
      _id,
      name,
      studentCount: 0,
      pendingStudentId: 0,
      isArchived: false,
      startDate: startSemester ? startSemester.startDate : null,
      startSemesterName: startSemester ? startSemester.name : null,
    },
  };
};

// 调整班级的入学学期；传空表示不限制（可查看全部学期）
actions['class.setStartSemester'] = async ({ user, payload }) => {
  requireTeacher(user);
  const name = String(payload.name || '').trim();
  if (!name) fail('班级名称不能为空');
  const cls = await getOrCreateClassDoc(name, user);
  if (!cls) fail('班级不存在：' + name);

  let startSemester = null;
  if (payload.semesterId) {
    const res = await db.collection('semesters').doc(payload.semesterId).get();
    startSemester = res.data;
    if (!startSemester) fail('学期不存在');
  }
  await db.collection('classes').doc(cls._id).update({
    data: {
      startSemesterId: startSemester ? startSemester._id : null,
      startDate: startSemester ? startSemester.startDate : null,
    },
  });
  return {
    message: startSemester ? `入学学期已设为${startSemester.name}` : '已取消入学学期限制',
  };
};

actions['class.rename'] = async ({ user, payload }) => {
  requireTeacher(user);
  const oldName = String(payload.oldName || '').trim();
  const name = String(payload.name || '').trim();
  if (!oldName || !name) fail('班级名称不能为空');
  if (oldName === name) return { message: '名称未变化' };

  const exists = await db.collection('classes').where({ name }).count();
  if (exists.total) fail('该班级名称已存在');

  const target = await db.collection('classes').where({ name: oldName }).limit(1).get();
  if (target.data.length) {
    await db.collection('classes').doc(target.data[0]._id).update({ data: { name } });
  } else {
    await ensureClass(name, user);
  }
  // 学生记录以班级名关联，需一并更新
  await db.collection('students').where({ className: oldName }).update({ data: { className: name } });
  await db.collection('attendanceCodes').where({ className: oldName }).update({ data: { className: name } });
  return { message: `已重命名为${name}` };
};

actions['class.remove'] = async ({ user, payload }) => {
  requireTeacher(user);
  const name = String(payload.name || '').trim();
  if (!name) fail('班级名称不能为空');
  const used = await db.collection('students').where({ className: name }).count();
  if (used.total) fail(`该班级下还有 ${used.total} 名学生，请先转出或删除学生`);

  const target = await db.collection('classes').where({ name }).limit(1).get();
  if (!target.data.length) fail('班级不存在');
  await db.collection('classes').doc(target.data[0]._id).remove();
  return { message: '班级已删除' };
};

/**
 * 批量导入班级名册（分批调用）。
 * 名册只有姓名和手机号时，学生以手机号登录，学号待分配。
 * 按手机号/学号去重，重复导入不会产生副本。
 */
actions['class.importRoster'] = async ({ user, payload }) => {
  requireTeacher(user);
  const className = String(payload.className || '').trim();
  const rows = Array.isArray(payload.students) ? payload.students : [];
  if (!className) fail('请指定班级名称');
  if (!rows.length) return { inserted: 0, skipped: 0, failed: [] };

  const startSemester = payload.startSemesterId
    ? (await db.collection('semesters').doc(payload.startSemesterId).get()).data
    : await resolveCurrentSemester();
  await ensureClass(className, user, startSemester);
  const existing = await fetchAll(db.collection('students'));
  const usedKeys = new Set(existing.map((s) => s.studentId));
  const usedPhones = new Set(existing.filter((s) => s.phone).map((s) => s.phone));

  const result = { inserted: 0, skipped: 0, failed: [] };
  for (const row of rows) {
    const name = String(row.name || '').trim();
    const phone = String(row.phone || '').trim();
    const studentId = String(row.studentId || '').trim();
    const key = studentId || phone;
    if (!name || !key) {
      result.failed.push({ name: name || '(无姓名)', reason: '缺少姓名或手机号' });
      continue;
    }
    if (usedKeys.has(key) || (phone && usedPhones.has(phone))) {
      result.skipped++;
      continue;
    }
    try {
      await createStudent({ name, studentId, phone, className });
      usedKeys.add(key);
      if (phone) usedPhones.add(phone);
      result.inserted++;
    } catch (e) {
      result.failed.push({ name, reason: e.message });
    }
  }
  return result;
};

// ---------- 积分 ----------

actions['score.add'] = async ({ user, payload }) => {
  requireTeacher(user);
  const studentId = String(payload.studentId || '').trim();
  const scoreType = String(payload.scoreType || '');
  const score = Number(payload.score);
  if (!studentId) fail('学号不能为空');
  if (SCORE_TYPES.indexOf(scoreType) < 0) fail('积分类型无效');
  if (!Number.isFinite(score) || score === 0) fail('分值必须是非零数字');

  const student = await db.collection('students').where({ studentId }).limit(1).get();
  if (!student.data.length) fail('学生不存在');

  const now = new Date();
  const record = {
    studentId,
    semesterId: payload.semesterId || (await currentSemesterId()),
    scoreType,
    score,
    reason: String(payload.reason || ''),
    operator: user.username,
    timestamp: now,
    day: beijingDay(now),
  };
  const res = await db.collection('scoreRecords').add({ data: record });
  return { record: { _id: res._id, ...record, studentName: student.data[0].name } };
};

actions['score.list'] = async ({ user, payload }) => {
  requireLogin(user);
  const where = {};
  if (payload.studentId) where.studentId = String(payload.studentId).trim();
  if (payload.scoreType) where.scoreType = payload.scoreType;
  if (!payload.allSemesters) {
    const semesterId = payload.semesterId || (await currentSemesterId());
    if (semesterId) where.semesterId = semesterId;
  }
  if (payload.startDay && payload.endDay) {
    where.day = _.gte(payload.startDay).and(_.lte(payload.endDay));
  }

  const scope = await buildScope(user, payload);
  const all = await fetchAll(
    db.collection('scoreRecords').where(where).orderBy('timestamp', 'desc')
  );
  const records = all.filter((r) => scope.match(r));
  const limited = records.slice(0, Number(payload.limit) || 200);
  const [students, semesters] = [await studentMap(), await semesterMap()];
  return {
    records: decorate(limited, students, semesters),
    total: records.length,
    className: scope.className,
  };
};

// ---------- 考勤 ----------

// 教师生成短效考勤二维码：同一场次同一时刻只保留一个有效码
actions['attendance.createCode'] = async ({ user, payload }) => {
  requireTeacher(user);
  let ttl = Number(payload.ttl) || DEFAULT_CODE_TTL;
  ttl = Math.min(MAX_CODE_TTL, Math.max(MIN_CODE_TTL, Math.round(ttl)));

  const className = String(payload.className || '').trim();
  if (!className) fail('请先选择要考勤的班级');
  const session = normalizeSession(payload.session);

  const now = new Date();
  // 作废该教师此前尚未过期的考勤码。只作废同一场次的：
  // 面授课的码还在倒计时，不该被新生成的晚修码顶掉
  const stale = await db
    .collection('attendanceCodes')
    .where({ createdBy: user.username, revoked: _.neq(true), expireAt: _.gt(now) })
    .get();
  for (const code of stale.data) {
    if ((code.session || DEFAULT_SESSION) !== session) continue;
    await db.collection('attendanceCodes').doc(code._id).update({ data: { revoked: true } });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const expireAt = new Date(now.getTime() + ttl * 1000);
  const data = {
    token,
    ttl,
    className,
    session,
    semesterId: await currentSemesterId(),
    createdBy: user.username,
    createdAt: now,
    expireAt,
    day: beijingDay(now),
    revoked: false,
    checkinCount: 0,
  };
  const res = await db.collection('attendanceCodes').add({ data });

  return {
    codeId: res._id,
    content: QR_PREFIX + token,
    ttl,
    className,
    session,
    sessionLabel: SESSION_LABELS[session],
    expireAt: expireAt.getTime(),
    serverNow: now.getTime(),
  };
};

// 教师端查询某个考勤码的实时扫码情况
actions['attendance.codeStatus'] = async ({ user, payload }) => {
  requireTeacher(user);
  if (!payload.codeId) fail('缺少考勤码标识');
  const code = await db.collection('attendanceCodes').doc(payload.codeId).get();
  if (!code.data) fail('考勤码不存在');

  const records = await fetchAll(
    db.collection('scoreRecords').where({ codeId: payload.codeId }).orderBy('timestamp', 'desc')
  );
  const students = await studentMap();
  const now = new Date();
  const session = code.data.session || DEFAULT_SESSION;
  return {
    session,
    sessionLabel: SESSION_LABELS[session],
    expired: code.data.revoked === true || new Date(code.data.expireAt).getTime() <= now.getTime(),
    expireAt: new Date(code.data.expireAt).getTime(),
    serverNow: now.getTime(),
    checkins: records.map((r) => ({
      studentId: r.studentId,
      studentName: students[r.studentId] ? students[r.studentId].name : null,
      timestamp: r.timestamp,
    })),
  };
};

actions['attendance.revokeCode'] = async ({ user, payload }) => {
  requireTeacher(user);
  if (!payload.codeId) fail('缺少考勤码标识');
  await db.collection('attendanceCodes').doc(payload.codeId).update({ data: { revoked: true } });
  return { message: '二维码已失效' };
};

/**
 * 当天该学生某个场次是否已打卡。
 * 升级前的考勤记录没有 session 字段，查库时用 session:'day' 会漏掉它们，
 * 于是同一个人当天还能再打一次面授。因此先按天取回再在内存里判定。
 */
async function attendanceOf(studentId, day) {
  const rows = await fetchAll(
    db.collection('scoreRecords').where({ studentId, scoreType: 'attendance', day })
  );
  const map = {};
  for (const r of rows) map[r.session || DEFAULT_SESSION] = r;
  return map;
}

// 学生扫码打卡：必须携带教师端生成且尚未过期的令牌
actions['attendance.checkin'] = async ({ user, payload }) => {
  requireLogin(user);
  if (!user.studentId) fail('当前账号未绑定学生信息，无法打卡');

  const raw = String(payload.content || '').trim();
  if (raw.indexOf(QR_PREFIX) !== 0) fail('不是有效的考勤二维码，请扫描教师端出示的二维码');
  const token = raw.slice(QR_PREFIX.length);

  const res = await db.collection('attendanceCodes').where({ token }).limit(1).get();
  const code = res.data[0];
  if (!code) fail('二维码无效，请让教师重新生成');
  if (code.revoked === true) fail('二维码已失效，请扫描教师端最新的二维码');

  const now = new Date();
  if (new Date(code.expireAt).getTime() <= now.getTime()) {
    fail('二维码已过期，请扫描教师端刷新后的二维码');
  }

  const student = await db.collection('students').where({ studentId: user.studentId }).limit(1).get();
  if (!student.data.length) fail('学生信息不存在，请联系教师');

  // 二维码绑定了班级，跨班扫码一律拒绝
  if (code.className && student.data[0].className !== code.className) {
    fail(`该二维码属于「${code.className}」，你不在这个班级`);
  }

  // 场次取自二维码本身，学生无从选择，扫哪个码就记哪一场
  const session = code.session || DEFAULT_SESSION;
  const label = SESSION_LABELS[session];

  const day = beijingDay(now);
  const done = await attendanceOf(user.studentId, day);
  if (done[session]) fail(`今日${label}已打卡，每人每场次每天只能打卡一次`);

  const record = {
    studentId: user.studentId,
    semesterId: code.semesterId || (await currentSemesterId()),
    scoreType: 'attendance',
    session,
    score: 1,
    reason: label + '扫码打卡',
    operator: user.username,
    timestamp: now,
    day,
    codeId: code._id,
  };
  const added = await db.collection('scoreRecords').add({ data: record });
  await db.collection('attendanceCodes').doc(code._id).update({ data: { checkinCount: _.inc(1) } });

  return {
    message: `${label}打卡成功，考勤加 1 分`,
    session,
    sessionLabel: label,
    record: { _id: added._id, ...record, studentName: student.data[0].name },
  };
};

// 教师补录打卡（学生忘带手机等情况）
actions['attendance.manualCheckin'] = async ({ user, payload }) => {
  requireTeacher(user);
  const studentId = String(payload.studentId || '').trim();
  if (!studentId) fail('学号不能为空');
  const session = normalizeSession(payload.session);
  const label = SESSION_LABELS[session];

  const student = await db.collection('students').where({ studentId }).limit(1).get();
  if (!student.data.length) fail('学生不存在');

  const now = new Date();
  const day = beijingDay(now);
  const done = await attendanceOf(studentId, day);
  if (done[session]) fail(`该学生今日${label}已打卡`);

  const record = {
    studentId,
    semesterId: await currentSemesterId(),
    scoreType: 'attendance',
    session,
    score: 1,
    reason: label + '考勤（教师补录）',
    operator: user.username,
    timestamp: now,
    day,
  };
  const added = await db.collection('scoreRecords').add({ data: record });
  return {
    message: label + '补录成功',
    session,
    sessionLabel: label,
    record: { _id: added._id, ...record, studentName: student.data[0].name },
  };
};

// 今日考勤概况：面授课与晚修分开统计，学生看自己的状态，教师看全班名单
actions['attendance.today'] = async ({ user, payload }) => {
  requireLogin(user);
  const day = beijingDay();
  const records = await fetchAll(
    db.collection('scoreRecords').where({ scoreType: 'attendance', day })
  );

  // 键为「学号|场次」，升级前没有 session 的记录归入面授
  const byKey = {};
  for (const r of records) byKey[r.studentId + '|' + (r.session || DEFAULT_SESSION)] = r;
  const stateOf = (studentId, session) => {
    const r = byKey[studentId + '|' + session];
    return {
      session,
      sessionLabel: SESSION_LABELS[session],
      checkedIn: !!r,
      timestamp: r ? r.timestamp : null,
      reason: r ? r.reason : null,
    };
  };

  if (user.role === 'student') {
    const sessions = ATTENDANCE_SESSIONS.map((x) => stateOf(user.studentId, x));
    const day1 = sessions[0];
    return {
      day,
      sessions,
      // 兼容旧版小程序：这几个字段仍指面授课
      checkedIn: day1.checkedIn,
      timestamp: day1.timestamp,
      via: day1.reason,
    };
  }

  const className = await resolveClassName(user, payload);
  const list = await fetchAll(
    className
      ? db.collection('students').where({ className }).orderBy('name', 'asc')
      : db.collection('students').orderBy('className', 'asc')
  );

  const students = list.map((s) => {
    const sessions = ATTENDANCE_SESSIONS.map((x) => stateOf(s.studentId, x));
    return {
      studentId: s.studentId,
      name: s.name,
      className: s.className,
      studentIdAssigned: s.studentIdAssigned !== false,
      phone: s.phone || null,
      sessions,
      checkedIn: sessions[0].checkedIn,
      timestamp: sessions[0].timestamp,
      reason: sessions[0].reason,
    };
  });

  const counts = {};
  for (const x of ATTENDANCE_SESSIONS) {
    counts[x] = students.filter((s) => s.sessions.find((v) => v.session === x).checkedIn).length;
  }

  return {
    day,
    className,
    total: list.length,
    sessionCounts: counts,
    checkedInCount: counts[DEFAULT_SESSION],
    students,
  };
};

// ---------- 奖励 ----------

actions['reward.add'] = async ({ user, payload }) => {
  requireTeacher(user);
  const studentId = String(payload.studentId || '').trim();
  const rewardType = String(payload.rewardType || '');
  if (!studentId) fail('学号不能为空');
  if (REWARD_TYPES.indexOf(rewardType) < 0) fail('奖励类型无效，应为一等奖/二等奖/三等奖');

  const student = await db.collection('students').where({ studentId }).limit(1).get();
  if (!student.data.length) fail('学生不存在');

  const timestamp = payload.timestamp ? new Date(payload.timestamp) : new Date();
  const reward = {
    studentId,
    semesterId: await currentSemesterId(),
    rewardType,
    certificateImage: CERTIFICATE_IMAGES[rewardType] || '',
    reason: String(payload.reason || ''),
    operator: user.username,
    timestamp: isNaN(timestamp.getTime()) ? new Date() : timestamp,
    isRedeemed: false,
    redeemedAt: null,
  };
  const res = await db.collection('rewards').add({ data: reward });
  return { reward: { _id: res._id, ...reward, studentName: student.data[0].name } };
};

actions['reward.list'] = async ({ user, payload }) => {
  requireLogin(user);
  const where = {};
  // 学生只能查看自己的奖励记录
  if (user.role === 'student') {
    where.studentId = user.studentId;
  } else if (payload.studentId) {
    where.studentId = String(payload.studentId).trim();
  }
  if (!payload.allSemesters) {
    const semesterId = payload.semesterId || (await currentSemesterId());
    if (semesterId) where.semesterId = semesterId;
  }

  const scope = await buildScope(user, payload);
  const all = await fetchAll(db.collection('rewards').where(where).orderBy('timestamp', 'desc'));
  const rewards = all.filter((r) => scope.match(r));
  const [students, semesters] = [await studentMap(), await semesterMap()];
  return { rewards: decorate(rewards, students, semesters) };
};

actions['reward.redeem'] = async ({ user, payload }) => {
  requireTeacher(user);
  const res = await db.collection('rewards').doc(payload.rewardId).get();
  if (!res.data) fail('奖励记录不存在');
  if (res.data.isRedeemed) fail('该奖券已兑换');
  await db.collection('rewards').doc(payload.rewardId).update({
    data: { isRedeemed: true, redeemedAt: new Date() },
  });
  return { message: '兑换成功' };
};

actions['reward.unredeem'] = async ({ user, payload }) => {
  requireTeacher(user);
  const res = await db.collection('rewards').doc(payload.rewardId).get();
  if (!res.data) fail('奖励记录不存在');
  if (!res.data.isRedeemed) fail('该奖券尚未兑换');
  await db.collection('rewards').doc(payload.rewardId).update({
    data: { isRedeemed: false, redeemedAt: null },
  });
  return { message: '已取消兑换' };
};

// ---------- 统计 ----------

actions['stats.overview'] = async ({ user, payload }) => {
  requireLogin(user);
  const semesterId = payload.semesterId || (await currentSemesterId());
  const scope = await buildScope(user, payload);
  const className = scope.className;

  const students = await fetchAll(
    className ? db.collection('students').where({ className }) : db.collection('students')
  );
  const all = await fetchAll(
    semesterId ? db.collection('scoreRecords').where({ semesterId }) : db.collection('scoreRecords')
  );
  const records = all.filter((r) => scope.match(r));

  const typeStats = {};
  for (const t of SCORE_TYPES) typeStats[t] = 0;
  const today = beijingDay();
  let todayScores = 0;
  const activeStudents = new Set();

  for (const r of records) {
    if (typeStats[r.scoreType] === undefined) typeStats[r.scoreType] = 0;
    typeStats[r.scoreType] += r.score;
    if (r.day === today) {
      todayScores += r.score;
      if (r.scoreType === 'attendance') activeStudents.add(r.studentId);
    }
  }

  let myTotal = null;
  if (user.role === 'student') {
    myTotal = records
      .filter((r) => r.studentId === user.studentId)
      .reduce((sum, r) => sum + r.score, 0);
  }

  return {
    totalStudents: students.length,
    scoreTypeStats: typeStats,
    totalScores: Object.keys(typeStats).reduce((sum, k) => sum + typeStats[k], 0),
    todayScores,
    activeStudents: activeStudents.size,
    myTotalScore: myTotal,
    semesterId,
    className,
  };
};

actions['stats.ranking'] = async ({ user, payload }) => {
  requireLogin(user);
  const semesterId = payload.semesterId || (await currentSemesterId());
  const scope = await buildScope(user, payload);
  const className = scope.className;

  const students = await fetchAll(
    className ? db.collection('students').where({ className }) : db.collection('students')
  );
  const all = await fetchAll(
    semesterId ? db.collection('scoreRecords').where({ semesterId }) : db.collection('scoreRecords')
  );
  const records = all.filter((r) => scope.match(r));

  const totals = {};
  for (const r of records) totals[r.studentId] = (totals[r.studentId] || 0) + r.score;

  const ranking = students
    .map((s) => ({
      studentId: s.studentId,
      name: s.name,
      className: s.className,
      studentIdAssigned: s.studentIdAssigned !== false,
      totalScore: totals[s.studentId] || 0,
    }))
    .sort((a, b) => b.totalScore - a.totalScore);

  return { ranking, semesterId, className };
};

// 最近 7 天积分趋势：学生看自己的，教师看全班的
actions['stats.trend'] = async ({ user, payload }) => {
  requireLogin(user);
  const semesterId = payload.semesterId || (await currentSemesterId());
  const today = beijingDay();
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(shiftDay(today, -i));

  const where = { day: _.gte(days[0]).and(_.lte(days[6])) };
  if (semesterId) where.semesterId = semesterId;
  if (user.role === 'student') where.studentId = user.studentId;

  const scope = await buildScope(user, payload);
  const className = scope.className;
  const all = await fetchAll(db.collection('scoreRecords').where(where));
  const records = all.filter((r) => scope.match(r));
  const byDay = {};
  for (const d of days) byDay[d] = 0;
  for (const r of records) {
    if (byDay[r.day] !== undefined) byDay[r.day] += r.score;
  }

  return {
    days,
    labels: days.map((d) => d.slice(5)),
    values: days.map((d) => byDay[d]),
    role: user.role,
    semesterId,
    className,
  };
};

// ---------- 课程与成绩 ----------

// 统设必修课：课程类型为「统设」且课程性质以「必修」开头（含「必修(分部)」）
function isRequiredCourse(course) {
  return !!course && course.courseType === '统设' && /^必修/.test(String(course.courseNature || ''));
}

function isPassed(record) {
  return record.status === '及格';
}

const scoreOf = (r) => (Number.isFinite(Number(r.totalScore)) ? Number(r.totalScore) : 0);

/**
 * 每门课只保留综合成绩最高的一次。
 * 补考通过后应以通过的那次为准，重复参加也取最好成绩。
 */
function bestAttempts(records) {
  const best = {};
  for (const r of records) {
    const k = r.studentId + '|' + r.courseCode;
    if (!best[k] || scoreOf(r) > scoreOf(best[k])) best[k] = r;
  }
  return Object.values(best);
}

/**
 * 解析本次请求适用的专业规则号：取班级上绑定的规则；
 * 未绑定时回退到库中第一套规则，避免课程查询直接空白。
 */
async function resolveRuleCode(user, payload) {
  const explicit = String((payload && payload.ruleCode) || '').trim();
  if (explicit && user.role === 'teacher') return explicit;

  // 学生看自己的规则：先看学生档案上的绑定，再退到班级默认
  if (user.role === 'student') {
    const students = await studentMap();
    const me = students[user.studentId];
    if (me && me.ruleCode) return me.ruleCode;
  }

  const className = await resolveClassName(user, payload);
  const cls = await getClassDoc(className);
  if (cls && cls.ruleCode) return cls.ruleCode;

  const majors = await fetchAll(db.collection('majors'));
  return majors.length ? majors[0].ruleCode : null;
}

/**
 * 逐个学生解析适用的专业规则。
 * 同一个班可能有不同入学年份的学生（补入班级、留级、转专业），
 * 他们适用的规则版本不同，成绩统计必须按人取规则，不能整班共用一套。
 */
async function buildRuleResolver() {
  const [students, classes, majors, courses] = await Promise.all([
    fetchAll(db.collection('students')),
    fetchAll(db.collection('classes')),
    fetchAll(db.collection('majors')).catch(() => []),
    fetchAll(db.collection('courses')).catch(() => []),
  ]);

  const classRule = {};
  for (const c of classes) classRule[c.name] = c.ruleCode || null;

  const fallbackRule = majors.length ? majors[0].ruleCode : null;
  const ruleOfStudent = {};
  for (const st of students) {
    ruleOfStudent[st.studentId] = st.ruleCode || classRule[st.className] || fallbackRule || null;
  }

  const byRule = {};
  const anyCourse = {};
  for (const c of courses) {
    (byRule[c.ruleCode] = byRule[c.ruleCode] || {})[c.code] = c;
    if (!anyCourse[c.code]) anyCourse[c.code] = c;
  }

  return {
    ruleOf(studentId) {
      return ruleOfStudent[studentId] || fallbackRule || null;
    },
    /**
     * 该学生适用规则下、学校实际开设的课程，按教学进程表的顺序返回。
     * offered 是后加的字段，老库里没有的一律当作开设，避免升级前的数据整批消失。
     */
    offeredCoursesOf(studentId) {
      const rule = this.ruleOf(studentId);
      if (!rule || !byRule[rule]) return [];
      return Object.values(byRule[rule])
        .filter((c) => c.offered !== false)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
    },
    // 本规则内找不到时回退到其他规则版本，并标记来源，避免丢失学分与性质
    courseFor(studentId, code) {
      const rule = this.ruleOf(studentId);
      const own = rule && byRule[rule] ? byRule[rule][code] : null;
      if (own) return { ...own, fromOtherRule: false };
      if (anyCourse[code]) return { ...anyCourse[code], fromOtherRule: true };
      return null;
    },
  };
}

/**
 * 课程索引：先用本专业规则，找不到再回退到其他规则版本并标记来源。
 * 成绩里出现本规则没有的课程时（跨规则版本选课），仍能显示学分与性质。
 */
async function courseIndex(ruleCode) {
  const all = await fetchAll(db.collection('courses'));
  const own = {};
  const fallback = {};
  for (const c of all) {
    if (c.ruleCode === ruleCode) own[c.code] = c;
    else if (!fallback[c.code]) fallback[c.code] = c;
  }
  return {
    all,
    get(code) {
      if (own[code]) return { ...own[code], fromOtherRule: false };
      if (fallback[code]) return { ...fallback[code], fromOtherRule: true };
      return null;
    },
    ownList() {
      return Object.values(own);
    },
  };
}

// 教师批量导入专业规则、课程与考试成绩；按唯一键去重，可重复执行
actions['academic.import'] = async ({ user, payload }) => {
  requireTeacher(user);
  for (const name of ['majors', 'courses', 'examScores']) await ensureCollection(name);

  const majors = Array.isArray(payload.majors) ? payload.majors : [];
  const courses = Array.isArray(payload.courses) ? payload.courses : [];
  const scores = Array.isArray(payload.scores) ? payload.scores : [];
  const result = { majors: 0, courses: 0, scores: 0, updated: 0, skipped: 0 };

  const [existMajors, existCourses, existScores] = await Promise.all([
    fetchAll(db.collection('majors')),
    fetchAll(db.collection('courses')),
    fetchAll(db.collection('examScores')),
  ]);
  const majorKeys = new Set(existMajors.map((m) => m.ruleCode));
  const courseKeys = new Set(existCourses.map((c) => c.ruleCode + '|' + c.code));
  const courseById = {};
  for (const c of existCourses) courseById[c.ruleCode + '|' + c.code] = c;
  const scoreKeys = new Set(
    existScores.map((s) => [s.term, s.studentId, s.courseCode, s.paperNo].join('|'))
  );

  const writes = [];
  for (const m of majors) {
    if (majorKeys.has(m.ruleCode)) {
      result.skipped++;
      continue;
    }
    majorKeys.add(m.ruleCode);
    result.majors++;
    writes.push(db.collection('majors').add({ data: { ...m, createdAt: new Date() } }));
  }
  for (const c of courses) {
    const k = c.ruleCode + '|' + c.code;
    if (courseKeys.has(k)) {
      // 导入是幂等的，但 offered（学校是否实际开设）是后加的字段，
      // 老库里的课程没有，这里补上，否则待修读会把没开设的选修课也算进去
      const old = courseById[k];
      if (old && typeof c.offered === 'boolean' && old.offered !== c.offered) {
        result.updated++;
        writes.push(
          db.collection('courses').doc(old._id).update({ data: { offered: c.offered } })
        );
      } else {
        result.skipped++;
      }
      continue;
    }
    courseKeys.add(k);
    result.courses++;
    writes.push(db.collection('courses').add({ data: c }));
  }
  for (const s of scores) {
    const k = [s.term, s.studentId, s.courseCode, s.paperNo].join('|');
    if (scoreKeys.has(k)) {
      result.skipped++;
      continue;
    }
    scoreKeys.add(k);
    result.scores++;
    writes.push(db.collection('examScores').add({ data: s }));
  }

  await Promise.all(writes);
  return result;
};

// 课程信息查询：按专业规则返回课程清单，可按性质、类型、考试单位、模块筛选
actions['course.list'] = async ({ user, payload }) => {
  requireLogin(user);
  const ruleCode = await resolveRuleCode(user, payload);
  if (!ruleCode) return { courses: [], major: null, ruleCode: null, summary: null };

  const majorRes = await db.collection('majors').where({ ruleCode }).limit(1).get();
  const index = await courseIndex(ruleCode);
  let courses = index.ownList();

  const nature = String(payload.courseNature || '').trim();
  const type = String(payload.courseType || '').trim();
  const unit = String(payload.examUnit || '').trim();
  const module2 = String(payload.level2Module || '').trim();
  const keyword = String(payload.keyword || '').trim();

  if (payload.requiredOnly) courses = courses.filter(isRequiredCourse);
  if (nature) courses = courses.filter((c) => String(c.courseNature || '').startsWith(nature));
  if (type) courses = courses.filter((c) => c.courseType === type);
  if (unit) courses = courses.filter((c) => c.examUnit === unit);
  if (module2) courses = courses.filter((c) => c.level2Module === module2);
  if (keyword) {
    courses = courses.filter((c) => c.name.indexOf(keyword) >= 0 || c.code.indexOf(keyword) >= 0);
  }

  courses.sort((a, b) => (a.order || 0) - (b.order || 0));

  const own = index.ownList();
  const required = own.filter(isRequiredCourse);
  return {
    ruleCode,
    major: majorRes.data[0] || null,
    courses: courses.map((c) => ({ ...c, isRequired: isRequiredCourse(c) })),
    modules: [...new Set(own.map((c) => c.level2Module).filter(Boolean))],
    summary: {
      total: own.length,
      totalCredits: own.reduce((n, c) => n + (c.credits || 0), 0),
      requiredCount: required.length,
      requiredCredits: required.reduce((n, c) => n + (c.credits || 0), 0),
    },
  };
};

// 按角色收窄成绩查询范围：学生只能看自己的
async function examScopeStudentIds(user, payload) {
  if (user.role === 'student') return [user.studentId];
  const explicit = String(payload.studentId || '').trim();
  if (explicit) return [explicit];
  const className = await resolveClassName(user, payload);
  if (!className) return null; // 教师未选班级表示不限
  const ids = await classStudentIds(className);
  return ids ? [...ids] : [];
}

async function loadExamRecords(user, payload) {
  const ids = await examScopeStudentIds(user, payload);
  const all = await fetchAll(db.collection('examScores'));
  return ids ? all.filter((r) => ids.indexOf(r.studentId) >= 0) : all;
}

// 成绩查询：保留原表全部字段，并补上课程规则里的学分与性质
actions['exam.list'] = async ({ user, payload }) => {
  requireLogin(user);
  const resolver = await buildRuleResolver();
  const students = await studentMap();

  let records = await loadExamRecords(user, payload);
  const courseCode = String(payload.courseCode || '').trim();
  const term = String(payload.term || '').trim();
  const keyword = String(payload.keyword || '').trim();

  if (courseCode) records = records.filter((r) => r.courseCode === courseCode);
  if (term) records = records.filter((r) => r.term === term);
  if (keyword) {
    records = records.filter(
      (r) => r.courseName.indexOf(keyword) >= 0 || r.courseCode.indexOf(keyword) >= 0
    );
  }
  if (payload.requiredOnly) {
    records = records.filter((r) => isRequiredCourse(resolver.courseFor(r.studentId, r.courseCode)));
  }
  if (payload.failedOnly) records = records.filter((r) => !isPassed(r));
  if (payload.bestOnly) records = bestAttempts(records);

  records.sort((a, b) => (a.term < b.term ? 1 : a.term > b.term ? -1 : a.courseCode < b.courseCode ? -1 : 1));

  const decorated = records.slice(0, Number(payload.limit) || 300).map((r) => {
    const c = resolver.courseFor(r.studentId, r.courseCode);
    return {
      ...r,
      studentName: students[r.studentId] ? students[r.studentId].name : null,
      credits: c ? c.credits : null,
      courseType: c ? c.courseType : null,
      courseNature: c ? c.courseNature : null,
      examUnit: c ? c.examUnit : null,
      level2Module: c ? c.level2Module : null,
      isRequired: isRequiredCourse(c),
      // 该课不在本人适用的专业规则内，属性取自其他规则版本
      fromOtherRule: c ? c.fromOtherRule : false,
      inPlan: !!(c && !c.fromOtherRule),
      ruleCode: resolver.ruleOf(r.studentId),
    };
  });

  return {
    records: decorated,
    total: records.length,
    terms: [...new Set((await loadExamRecords(user, payload)).map((r) => r.term))].sort().reverse(),
  };
};

/**
 * 成绩汇总：按「统设必修」与「全部课程」两种口径各给两个算术平均分。
 * 含未过：每门课取最高综合成绩后平均，未通过的课按实际分数计入（无效课程为 0）；
 * 仅已过：只统计已及格的课程。两者差距越大，说明挂科拖累越重。
 */
function summarize(records, resolver, scope) {
  let rows = bestAttempts(records);
  if (scope === 'required') {
    rows = rows.filter((r) => isRequiredCourse(resolver.courseFor(r.studentId, r.courseCode)));
  }

  const passed = rows.filter(isPassed);
  const pending = rows.filter((r) => !isPassed(r));
  const mean = (arr) =>
    arr.length ? Math.round((arr.reduce((n, v) => n + v, 0) / arr.length) * 10) / 10 : null;

  const creditsOf = (r) => {
    const c = resolver.courseFor(r.studentId, r.courseCode);
    return c && Number.isFinite(c.credits) ? c.credits : 0;
  };

  return {
    scope,
    courseCount: rows.length,
    passedCount: passed.length,
    pendingCount: pending.length,
    avgIncludingFailed: mean(rows.map(scoreOf)),
    avgPassedOnly: mean(passed.map(scoreOf)),
    earnedCredits: passed.reduce((n, r) => n + creditsOf(r), 0),
    pendingCredits: pending.reduce((n, r) => n + creditsOf(r), 0),
  };
}

actions['exam.summary'] = async ({ user, payload }) => {
  requireLogin(user);
  const resolver = await buildRuleResolver();
  const records = await loadExamRecords(user, payload);
  const students = await studentMap();
  const majors = await fetchAll(db.collection('majors')).catch(() => []);
  const majorByRule = {};
  for (const m of majors) majorByRule[m.ruleCode] = m;

  const ids = [...new Set(records.map((r) => r.studentId))];
  const perStudent = ids
    .map((sid) => {
      const mine = records.filter((r) => r.studentId === sid);
      const rule = resolver.ruleOf(sid);
      return {
        studentId: sid,
        name: students[sid] ? students[sid].name : null,
        className: students[sid] ? students[sid].className : null,
        ruleCode: rule,
        ruleName: majorByRule[rule] ? majorByRule[rule].enrollTerm : null,
        required: summarize(mine, resolver, 'required'),
        all: summarize(mine, resolver, 'all'),
      };
    })
    .sort((a, b) => (b.all.avgIncludingFailed || 0) - (a.all.avgIncludingFailed || 0));

  return {
    studentCount: ids.length,
    students: perStudent,
    // 班里可能混着不同规则版本的学生，列出来便于核对
    ruleCodes: [...new Set(perStudent.map((s) => s.ruleCode).filter(Boolean))],
    overall: {
      required: summarize(records, resolver, 'required'),
      all: summarize(records, resolver, 'all'),
    },
  };
};

// 补考选课记录：键为「学号|课程代码」，学生自行勾选要报考哪几门
async function retakeSelectionMap() {
  let rows = [];
  try {
    rows = await fetchAll(db.collection('retakeSelections'));
  } catch (e) {
    await ensureCollection('retakeSelections');
  }
  const map = {};
  for (const r of rows) map[r.studentId + '|' + r.courseCode] = r;
  return map;
}

/**
 * 待补考名单：某门课历次考试都没及格就计入，无论必修还是选修——
 * 挂掉的选修课同样要重修，因此这里不套用平均分那套「统设必修」口径。
 * requiredOnly 仅在调用方明确要求时才收窄。
 */
async function computePending(user, payload) {
  const [resolver, students, selections] = await Promise.all([
    buildRuleResolver(),
    studentMap(),
    retakeSelectionMap(),
  ]);
  const records = await loadExamRecords(user, payload);

  const byKey = {};
  for (const r of records) {
    (byKey[r.studentId + '|' + r.courseCode] = byKey[r.studentId + '|' + r.courseCode] || []).push(r);
  }

  const decorate = (studentId, courseCode, courseName, extra) => {
    const c = resolver.courseFor(studentId, courseCode);
    const sel = selections[studentId + '|' + courseCode];
    return {
      selected: !!(sel && sel.selected),
      selectedAt: sel && sel.selected ? sel.updatedAt : null,
      selectedBy: sel && sel.selected ? sel.updatedBy : null,
      studentId,
      studentName: students[studentId] ? students[studentId].name : null,
      courseCode,
      courseName,
      credits: c ? c.credits : null,
      courseType: c ? c.courseType : null,
      courseNature: c ? c.courseNature : null,
      examUnit: c ? c.examUnit : null,
      level2Module: c ? c.level2Module : null,
      isRequired: isRequiredCourse(c),
      ...extra,
    };
  };

  let pending = Object.values(byKey)
    .filter((group) => !group.some(isPassed))
    .map((group) => {
      const best = group.reduce((a, b) => (scoreOf(b) > scoreOf(a) ? b : a));
      return decorate(best.studentId, best.courseCode, best.courseName, {
        attempts: group.length,
        lastTerm: group.map((r) => r.term).sort().pop(),
        bestScore: scoreOf(best),
        finalScore: best.finalScore,
        status: best.status,
        // 要求双及格的课程终考不足 60 分即判无效，综合记 0
        dualRequired: !!best.dualRequired,
      });
    });

  if (payload.requiredOnly) pending = pending.filter((p) => p.isRequired);
  if (payload.selectedOnly) pending = pending.filter((p) => p.selected);

  pending.sort(
    (a, b) =>
      (a.studentName || '').localeCompare(b.studentName || '') ||
      b.attempts - a.attempts ||
      a.courseCode.localeCompare(b.courseCode)
  );
  return pending;
}

actions['exam.pending'] = async ({ user, payload }) => {
  requireLogin(user);
  const pending = await computePending(user, payload);
  return {
    pending,
    total: pending.length,
    requiredTotal: pending.filter((p) => p.isRequired).length,
    pendingCredits: pending.reduce((n, p) => n + (p.credits || 0), 0),
    studentCount: new Set(pending.map((p) => p.studentId)).size,
    selectedTotal: pending.filter((p) => p.selected).length,
    selectedStudentCount: new Set(pending.filter((p) => p.selected).map((p) => p.studentId)).size,
  };
};

/**
 * 补考选课：学生勾选本学期要报考哪几门。
 * 只能勾选自己名下、且确实处于待补考状态的课程；
 * 教师可代任意学生勾选，便于学生不便操作时代办。
 */
actions['retake.select'] = async ({ user, payload }) => {
  requireLogin(user);
  const courseCode = String(payload.courseCode || '').trim();
  if (!courseCode) fail('缺少课程代码');
  const selected = payload.selected !== false;

  const studentId =
    user.role === 'student' ? user.studentId : String(payload.studentId || '').trim();
  if (!studentId) fail('缺少学号');
  if (user.role === 'student' && payload.studentId && payload.studentId !== user.studentId) {
    fail('只能为自己选课');
  }

  // 必须确实待补考：考过、且历次都没通过
  const attempts = await fetchAll(db.collection('examScores').where({ studentId, courseCode }));
  if (!attempts.length) fail('没有该课程的考试记录，无法报名补考');
  if (attempts.some(isPassed)) fail('该课程已通过，无需补考');
  const courseName = attempts[0].courseName;

  await ensureCollection('retakeSelections');
  const key = { studentId, courseCode };
  const existing = await db.collection('retakeSelections').where(key).limit(1).get();
  const data = {
    ...key,
    courseName,
    selected,
    updatedAt: new Date(),
    updatedBy: user.username,
  };
  if (existing.data.length) {
    await db.collection('retakeSelections').doc(existing.data[0]._id).update({ data });
  } else {
    await db.collection('retakeSelections').add({ data });
  }

  return {
    message: (selected ? '已报名补考：' : '已取消报名：') + courseName,
    courseName,
    selected,
  };
};

// 学生一次性提交本人的选课结果，避免逐门点击时反复往返
actions['retake.submit'] = async ({ user, payload }) => {
  requireLogin(user);
  const studentId =
    user.role === 'student' ? user.studentId : String(payload.studentId || '').trim();
  if (!studentId) fail('缺少学号');
  const codes = Array.isArray(payload.courseCodes) ? payload.courseCodes.map(String) : [];

  // 与页面上看到的名单同源，避免两处判定口径不一致
  const list = await computePending(user, { studentId });
  const nameByCode = {};
  for (const p of list) nameByCode[p.courseCode] = p.courseName;
  const pendingCodes = new Set(list.map((p) => p.courseCode));

  const invalid = codes.filter((c) => !pendingCodes.has(c));
  if (invalid.length) fail('以下课程不在待补考名单中：' + invalid.join('、'));

  await ensureCollection('retakeSelections');
  const existing = await fetchAll(db.collection('retakeSelections').where({ studentId }));
  const existingByCode = {};
  for (const e of existing) existingByCode[e.courseCode] = e;

  const wanted = new Set(codes);
  const writes = [];
  // 待补考的每一门都要落一条记录：选中的置 true，未选的置 false
  for (const code of pendingCodes) {
    const selected = wanted.has(code);
    const prev = existingByCode[code];
    if (prev && !!prev.selected === selected) continue;
    const data = {
      studentId,
      courseCode: code,
      courseName: nameByCode[code],
      selected,
      updatedAt: new Date(),
      updatedBy: user.username,
    };
    writes.push(
      prev
        ? db.collection('retakeSelections').doc(prev._id).update({ data })
        : db.collection('retakeSelections').add({ data })
    );
  }
  await Promise.all(writes);

  return { message: `已提交 ${codes.length} 门补考报名`, selectedCount: codes.length };
};

/**
 * 导出补考选课表，格式对齐学校的「批量导入选课记录」模板：
 * 第 1 行标题、第 2 行填表说明、第 3 行表头，第 4 行起为数据。
 * 生成后传到云存储，小程序端下载并用微信的文档预览打开或转发。
 */
const RETAKE_TEMPLATE = {
  sheetName: '0',
  title: '批量导入选课记录模板',
  notice:
    '填表说明：\r\n' +
    '1、以下所有标 * 的项均为必填项，请按照要求填写好再导入\r\n' +
    '2、学生需要选补修课，学生需要重修，单科注册生的选课，有特殊选课需求的这几种情况可以使用批量导入选课功能来选课，' +
    '其余正常按照教学计划进行选课的情况，建议采用自动生成选课功能来生成选课\r\n' +
    '3、新生学生学号填写身份证，老生填写学生学号。',
  header: ['学生姓名 *', '学生学号 *', '课程代码 *', '课程名称 *'],
};

/**
 * 待修读：本人适用规则里学校实际开设、但从未修读过的课程。
 *
 * 与待补考互不重叠——考过没及格的属于重修，走补考表；这里只列一次都没考过的。
 * 课程范围以各自规则版本的教学进程表为准：23 秋见「教学进程表(待修读)」列出的
 * 40 门（完整计划 52 门里有 12 门选修未开设），24 秋见专业规则 xls 的 39 门。
 */
async function computeTodo(user, payload) {
  const [resolver, students] = await Promise.all([buildRuleResolver(), studentMap()]);
  const records = await loadExamRecords(user, payload);

  const scopeIds = await examScopeStudentIds(user, payload);
  const all = Object.values(students);
  const inScope = scopeIds ? all.filter((st) => scopeIds.indexOf(st.studentId) >= 0) : all;

  // 修读过就不再是待修读，无论及格与否
  const taken = {};
  for (const r of records) {
    (taken[r.studentId] = taken[r.studentId] || new Set()).add(r.courseCode);
  }

  const rows = [];
  for (const st of inScope) {
    const done = taken[st.studentId] || new Set();
    for (const c of resolver.offeredCoursesOf(st.studentId)) {
      if (done.has(c.code)) continue;
      rows.push({
        studentId: st.studentId,
        studentName: st.name || null,
        className: st.className || null,
        ruleCode: c.ruleCode,
        order: c.order,
        courseCode: c.code,
        courseName: c.name,
        credits: c.credits,
        courseType: c.courseType,
        courseNature: c.courseNature,
        examUnit: c.examUnit,
        suggestedTerm: c.suggestedTerm,
        level1Module: c.level1Module,
        level2Module: c.level2Module,
        isRequired: isRequiredCourse(c),
      });
    }
  }

  if (payload.requiredOnly) return rows.filter((r) => r.isRequired);
  return rows;
}

actions['course.todo'] = async ({ user, payload }) => {
  requireLogin(user);
  const rows = await computeTodo(user, payload);
  rows.sort(
    (a, b) =>
      (a.studentName || '').localeCompare(b.studentName || '') || (a.order || 0) - (b.order || 0)
  );
  return {
    todo: rows,
    total: rows.length,
    requiredTotal: rows.filter((r) => r.isRequired).length,
    todoCredits: rows.reduce((n, r) => n + (r.credits || 0), 0),
    studentCount: new Set(rows.map((r) => r.studentId)).size,
  };
};

// 待修读选课表：与补考表同一张《批量导入选课记录》模板，只是课程来源不同
actions['course.exportTodo'] = async ({ user, payload }) => {
  requireTeacher(user);

  const students = await studentMap();
  const rows = await computeTodo(user, payload);
  rows.sort(
    (a, b) =>
      (a.studentName || '').localeCompare(b.studentName || '') || (a.order || 0) - (b.order || 0)
  );

  if (!rows.length) {
    fail(
      payload.requiredOnly
        ? '当前范围内没有待修读的统设必修课，无需导出'
        : '当前范围内没有待修读课程，无需导出'
    );
  }

  // 学号尚未下发的新生，模板要求填身份证，系统里没有，留空由教师补
  const accountOf = (r) => {
    const st = students[r.studentId];
    return st && st.studentIdAssigned === false ? '' : r.studentId;
  };

  const XLSX = require('xlsx');
  const ws = XLSX.utils.aoa_to_sheet([
    [RETAKE_TEMPLATE.title],
    [RETAKE_TEMPLATE.notice],
    RETAKE_TEMPLATE.header,
    ...rows.map((r) => [r.studentName || '', accountOf(r), r.courseCode, r.courseName]),
  ]);
  ws['!cols'] = [{ wch: 14 }, { wch: 20 }, { wch: 12 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, RETAKE_TEMPLATE.sheetName);
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const stamp = beijingDay().replace(/-/g, '');
  const scopeTag = payload.requiredOnly ? '统设必修' : '全部课程';
  const className = (await resolveClassName(user, payload)) || '全部班级';
  const cloudPath = `todo/${stamp}-${className}-${scopeTag}-${Date.now()}.xlsx`;
  const upload = await cloud.uploadFile({ cloudPath, fileContent: buffer });

  const missing = rows.filter((r) => !accountOf(r));
  return {
    fileID: upload.fileID,
    fileName: `待修读选课-${className}-${scopeTag}-${stamp}.xlsx`,
    rowCount: rows.length,
    studentCount: new Set(rows.map((r) => r.studentId)).size,
    todoCredits: rows.reduce((n, r) => n + (r.credits || 0), 0),
    scope: scopeTag,
    className,
    missingStudentId: [...new Set(missing.map((r) => r.studentName))],
  };
};

actions['exam.exportRetake'] = async ({ user, payload }) => {
  requireTeacher(user);

  // 直接复用页面上的那份名单，避免导出与页面口径分家
  const students = await studentMap();
  const pending = await computePending(user, payload);

  const rows = pending.map((p) => {
    const student = students[p.studentId];
    return {
      studentId: p.studentId,
      studentName: p.studentName || '',
      // 学号尚未下发的学生，模板要求填身份证，系统里没有，留空由教师补
      账号: student && student.studentIdAssigned === false ? '' : p.studentId,
      courseCode: p.courseCode,
      courseName: p.courseName,
      missingId: !!(student && student.studentIdAssigned === false),
    };
  });

  if (!rows.length) {
    fail(
      payload.selectedOnly
        ? '还没有学生报名补考，无法导出选课版。可让学生在「成绩查询 → 待补考」里勾选，或改导全部待补考科目'
        : '当前筛选条件下没有待补考科目，无需导出'
    );
  }

  const XLSX = require('xlsx');
  const aoa = [
    [RETAKE_TEMPLATE.title],
    [RETAKE_TEMPLATE.notice],
    RETAKE_TEMPLATE.header,
    ...rows.map((r) => [r.studentName, r.账号, r.courseCode, r.courseName]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 14 }, { wch: 20 }, { wch: 12 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, RETAKE_TEMPLATE.sheetName);
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const stamp = beijingDay().replace(/-/g, '');
  // 默认导全部待补考科目，只在调用方明确收窄到统设必修时才在文件名里标出来
  const scopeTag =
    (payload.selectedOnly ? '学生已选' : '全部待补考') + (payload.requiredOnly ? '-统设必修' : '');
  const className = (await resolveClassName(user, payload)) || '全部班级';
  const cloudPath = `retake/${stamp}-${className}-${scopeTag}-${Date.now()}.xlsx`;
  const upload = await cloud.uploadFile({ cloudPath, fileContent: buffer });

  const missing = rows.filter((r) => r.missingId);
  return {
    fileID: upload.fileID,
    fileName: `补考选课-${className}-${scopeTag}-${stamp}.xlsx`,
    rowCount: rows.length,
    studentCount: new Set(rows.map((r) => r.studentId)).size,
    scope: scopeTag,
    selectedOnly: !!payload.selectedOnly,
    className,
    // 模板要求新生填身份证，系统里没有该字段，这些行的学号留空需教师补齐
    missingStudentId: missing.map((r) => r.studentName),
  };
};

// 给班级绑定专业规则，课程与成绩查询据此确定适用的规则版本
actions['class.setRule'] = async ({ user, payload }) => {
  requireTeacher(user);
  const name = String(payload.name || '').trim();
  const ruleCode = String(payload.ruleCode || '').trim();
  if (!name) fail('班级名称不能为空');
  const cls = await getOrCreateClassDoc(name, user);
  if (!cls) fail('班级不存在：' + name);

  if (ruleCode) {
    const major = await db.collection('majors').where({ ruleCode }).limit(1).get();
    if (!major.data.length) fail('专业规则不存在：' + ruleCode);
  }
  await db.collection('classes').doc(cls._id).update({ data: { ruleCode: ruleCode || null } });
  return { message: ruleCode ? '已绑定专业规则' : '已解除专业规则绑定' };
};

actions['major.list'] = async ({ user }) => {
  requireLogin(user);
  let majors = [];
  try {
    majors = await fetchAll(db.collection('majors'));
  } catch (e) {
    await ensureCollection('majors');
  }
  const courses = majors.length ? await fetchAll(db.collection('courses')) : [];
  return {
    majors: majors.map((m) => ({
      ...m,
      courseCount: courses.filter((c) => c.ruleCode === m.ruleCode).length,
    })),
  };
};

// ---------- 学期 ----------

actions['semester.list'] = async ({ user, payload }) => {
  requireLogin(user);
  await syncCurrentSemesterFlag();
  const list = await fetchAll(db.collection('semesters').orderBy('startDate', 'desc'));

  // 入学之前的学期与该班无关，不返回给客户端
  const className = await resolveClassName(user, payload);
  const cls = await getClassDoc(className);
  const startDate = cls ? cls.startDate : null;
  return {
    semesters: list.filter((sem) => semesterVisibleToClass(sem, startDate)),
    className,
    classStartDate: startDate || null,
  };
};

actions['semester.current'] = async ({ user }) => {
  requireLogin(user);
  await syncCurrentSemesterFlag();
  const semester = await resolveCurrentSemester();
  return { semester };
};

actions['semester.create'] = async ({ user, payload }) => {
  requireTeacher(user);
  const name = String(payload.name || '').trim();
  const startDate = String(payload.startDate || '').trim();
  const endDate = String(payload.endDate || '').trim();
  if (!name || !startDate || !endDate) fail('学期名称、开始日期和结束日期不能为空');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    fail('日期格式错误，请使用 YYYY-MM-DD');
  }
  if (startDate >= endDate) fail('结束日期必须晚于开始日期');

  const exists = await db.collection('semesters').where({ name }).count();
  if (exists.total) fail('该学期已存在');

  const data = { name, startDate, endDate, isCurrent: false, isArchived: false, createdAt: new Date() };
  const res = await db.collection('semesters').add({ data });
  await syncCurrentSemesterFlag();
  return { semester: { _id: res._id, ...data } };
};

actions['semester.setCurrent'] = async ({ user, payload }) => {
  requireTeacher(user);
  const res = await db.collection('semesters').doc(payload.semesterId).get();
  const semester = res.data;
  if (!semester) fail('学期不存在');
  if (semester.isArchived) fail('存档学期不能设为当前学期，请直接浏览其历史数据');

  // 当前时间若已落在某个未存档学期内，当前学期由日期自动确定，不允许手动切换
  const ongoing = await findSemesterByDate();
  if (ongoing && ongoing._id !== semester._id) {
    fail(`当前时间正处于「${ongoing.name}」内，当前学期已按日期自动确定，无法切换到「${semester.name}」`);
  }

  const flagged = await db.collection('semesters').where({ isCurrent: true }).get();
  for (const s of flagged.data) {
    await db.collection('semesters').doc(s._id).update({ data: { isCurrent: false } });
  }
  await db.collection('semesters').doc(semester._id).update({ data: { isCurrent: true } });
  return { message: `已切换到${semester.name}` };
};

actions['semester.archive'] = async ({ user, payload }) => {
  requireTeacher(user);
  const res = await db.collection('semesters').doc(payload.semesterId).get();
  if (!res.data) fail('学期不存在');
  await db.collection('semesters').doc(payload.semesterId).update({
    data: { isArchived: true, isCurrent: false },
  });
  await syncCurrentSemesterFlag();
  return { message: `${res.data.name}已存档` };
};

actions['semester.remove'] = async ({ user, payload }) => {
  requireTeacher(user);
  const res = await db.collection('semesters').doc(payload.semesterId).get();
  if (!res.data) fail('学期不存在');

  // 保留数据本身，仅解除与该学期的关联
  await db.collection('scoreRecords').where({ semesterId: payload.semesterId }).update({
    data: { semesterId: null },
  });
  await db.collection('rewards').where({ semesterId: payload.semesterId }).update({
    data: { semesterId: null },
  });
  await db.collection('semesters').doc(payload.semesterId).remove();
  await syncCurrentSemesterFlag();
  return { message: '学期已删除' };
};

// ============================================================
// 入口
// ============================================================

// ---------- 积分排行榜快照 ----------

/**
 * 每周把积分排行榜脱敏后归档到 Gitee，云端数据万一丢失还能还原每个人的积分。
 *
 * 由 config.json 里的定时触发器每周执行一次，教师也可在「我的 → 数据备份」里手动跑。
 * 走 Gitee OpenAPI 直接提交文件，云函数里没有 git，也不需要本机开着。
 *
 * 脱敏规则与 scripts/snapshot-ranking.js 一致：姓名只留姓氏，学号手机只留后 4 位。
 * 教师对照名册能还原到人，但仓库里看不到完整身份。
 */
const SNAPSHOT_DIR = 'backup/ranking';

const SNAPSHOT_SCORE_TYPES = [
  ['attendance', '考勤'],
  ['homework', '课堂'],
  ['exam', '作业'],
  ['activity', '活动'],
  ['other', '其他'],
];

// 星号数固定，避免连名字有几个字都泄漏出去
function maskName(name) {
  const s = String(name || '').trim();
  return s ? s[0] + '**' : '（无名）';
}

function maskKey(key) {
  const s = String(key || '').trim();
  return s.length <= 4 ? s : '…' + s.slice(-4);
}

function buildSnapshotMarkdown(students, records, semesters, stamp) {
  const semesterName = {};
  for (const s of semesters) semesterName[s._id] = s.name;

  const lines = [
    '# 积分排行榜快照 · ' + stamp,
    '',
    '> 由云函数定时归档，姓名与标识已脱敏。共 ' +
      students.length +
      ' 名学生、' +
      records.length +
      ' 条积分记录。',
    '',
  ];

  const classes = [...new Set(students.map((s) => s.className || '未分班'))].sort();
  let sections = 0;

  for (const className of classes) {
    const classStudents = students.filter((s) => (s.className || '未分班') === className);
    const ids = new Set(classStudents.map((s) => s.studentId));
    const classRecords = records.filter((r) => ids.has(r.studentId));

    lines.push('## ' + className, '');
    if (!classRecords.length) {
      lines.push('_本班暂无积分记录_', '');
      sections++;
      continue;
    }

    const semesterIds = [...new Set(classRecords.map((r) => r.semesterId || null))];
    semesterIds.sort((a, b) => {
      const na = semesterName[a] || '';
      const nb = semesterName[b] || '';
      if (!na) return 1;
      if (!nb) return -1;
      return na < nb ? -1 : 1;
    });

    for (const sid of semesterIds) {
      const subset = classRecords.filter((r) => (r.semesterId || null) === sid);
      const days = subset.map((r) => r.day).filter(Boolean).sort();
      const range = days.length ? { from: days[0], to: days[days.length - 1] } : null;

      // 没有学期名时用日期区间兜底，否则多个学期会都叫「未知学期」而无法区分
      let label = semesterName[sid];
      if (!label) {
        label = sid ? '未知学期' : '未归属学期';
        if (range) label += '（' + range.from + ' 至 ' + range.to + '）';
      }

      const totals = {};
      const byType = {};
      for (const r of subset) {
        const id = r.studentId;
        totals[id] = (totals[id] || 0) + (Number(r.score) || 0);
        if (!byType[id]) byType[id] = {};
        byType[id][r.scoreType] = (byType[id][r.scoreType] || 0) + (Number(r.score) || 0);
      }

      const ranking = classStudents
        .map((s) => ({
          name: maskName(s.name),
          key: maskKey(s.studentId),
          total: totals[s.studentId] || 0,
          types: byType[s.studentId] || {},
        }))
        .sort((a, b) => b.total - a.total || (a.key < b.key ? -1 : 1));

      const sum = ranking.reduce((n, r) => n + r.total, 0);
      const meta = range
        ? '记录 ' + subset.length + ' 条，合计 ' + sum + ' 分，覆盖 ' + range.from + ' 至 ' + range.to + '。'
        : '记录 ' + subset.length + ' 条，合计 ' + sum + ' 分。';

      const header =
        '| 名次 | 姓名 | 标识 | ' + SNAPSHOT_SCORE_TYPES.map((t) => t[1]).join(' | ') + ' | 总分 |';
      const divider =
        '| ---: | --- | --- |' + SNAPSHOT_SCORE_TYPES.map(() => ' ---: |').join('') + ' ---: |';
      const rows = ranking.map(
        (r, i) =>
          '| ' +
          (i + 1) +
          ' | ' +
          r.name +
          ' | ' +
          r.key +
          ' | ' +
          SNAPSHOT_SCORE_TYPES.map((t) => r.types[t[0]] || 0).join(' | ') +
          ' | **' +
          r.total +
          '** |'
      );

      lines.push('### ' + label, '', meta, '', [header, divider, ...rows].join('\n'), '');
      sections++;
    }
  }

  return { markdown: lines.join('\n'), classCount: classes.length, sections };
}

// Gitee OpenAPI：云函数里没有 git，直接调「仓库文件」接口提交
function giteeConfig() {
  const env = process.env;
  return {
    token: env.GITEE_TOKEN || '',
    owner: env.GITEE_OWNER || '',
    repo: env.GITEE_REPO || '',
    branch: env.GITEE_BRANCH || 'master',
  };
}

function giteeRequest(method, path, body) {
  const https = require('https');
  const payload = body ? JSON.stringify(body) : null;
  const options = {
    hostname: 'gitee.com',
    path,
    method,
    headers: { Accept: 'application/json' },
    timeout: 15000,
  };
  if (payload) {
    options.headers['Content-Type'] = 'application/json';
    options.headers['Content-Length'] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let text = '';
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (e) {
          json = null;
        }
        resolve({ status: res.statusCode, body: json, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求 Gitee 超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * 写入（或覆盖）仓库里的一个文件。
 * Gitee 的更新接口要带上文件当前的 sha，所以先查一次：不存在就 POST 新建，存在就 PUT 覆盖。
 */
async function giteePutFile(cfg, filePath, content, message) {
  const base = '/api/v5/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + filePath;
  const query =
    '?access_token=' + encodeURIComponent(cfg.token) + '&ref=' + encodeURIComponent(cfg.branch);

  const exist = await giteeRequest('GET', base + query);
  const sha = exist.status === 200 && exist.body ? exist.body.sha : null;

  const body = {
    access_token: cfg.token,
    content: Buffer.from(content, 'utf8').toString('base64'),
    message,
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;

  const res = await giteeRequest(sha ? 'PUT' : 'POST', base, body);
  if (res.status >= 200 && res.status < 300) {
    return { updated: !!sha, url: res.body && res.body.content ? res.body.content.html_url : null };
  }
  const detail = res.body && res.body.message ? res.body.message : res.text.slice(0, 200);
  fail('提交到 Gitee 失败（HTTP ' + res.status + '）：' + detail);
}

/**
 * 生成快照并归档。Gitee 没配好也要照样把文件留在云存储里，
 * 否则一个令牌过期就等于这一周的备份彻底没了。
 */
async function runSnapshot(trigger) {
  const [students, records, semesters] = await Promise.all([
    fetchAll(db.collection('students')),
    fetchAll(db.collection('scoreRecords')),
    fetchAll(db.collection('semesters')).catch(() => []),
  ]);

  const stamp = beijingDay();
  const built = buildSnapshotMarkdown(students, records, semesters, stamp);
  const filePath = SNAPSHOT_DIR + '/' + stamp + '.md';

  // 云存储始终留一份，作为 Gitee 之外的第二个落点
  const upload = await cloud.uploadFile({
    cloudPath: 'ranking-snapshot/' + stamp + '.md',
    fileContent: Buffer.from(built.markdown, 'utf8'),
  });

  const result = {
    day: stamp,
    filePath,
    fileID: upload.fileID,
    studentCount: students.length,
    recordCount: records.length,
    classCount: built.classCount,
    sections: built.sections,
    trigger: trigger || 'manual',
    gitee: null,
  };

  const cfg = giteeConfig();
  if (!cfg.token || !cfg.owner || !cfg.repo) {
    result.gitee = {
      pushed: false,
      reason: '未配置 Gitee 环境变量（GITEE_TOKEN / GITEE_OWNER / GITEE_REPO），已只存云存储',
    };
    return result;
  }

  const pushed = await giteePutFile(
    cfg,
    filePath,
    built.markdown,
    '积分排行榜快照 ' + stamp + '（' + (trigger === 'timer' ? '定时归档' : '手动归档') + '）'
  );
  result.gitee = { pushed: true, ...pushed, repo: cfg.owner + '/' + cfg.repo, branch: cfg.branch };
  return result;
}

// 教师手动归档一次，便于配好令牌后当场验证
actions['snapshot.run'] = async ({ user }) => {
  requireTeacher(user);
  return runSnapshot('manual');
};

// 只看配置是否齐备与上次归档情况，不产生新文件
actions['snapshot.status'] = async ({ user }) => {
  requireTeacher(user);
  const cfg = giteeConfig();
  let recent = [];
  try {
    const res = await db
      .collection('snapshotLogs')
      .orderBy('createdAt', 'desc')
      .limit(10)
      .get();
    recent = res.data || [];
  } catch (e) {
    recent = [];
  }
  return {
    configured: !!(cfg.token && cfg.owner && cfg.repo),
    repo: cfg.owner && cfg.repo ? cfg.owner + '/' + cfg.repo : null,
    branch: cfg.branch,
    dir: SNAPSHOT_DIR,
    recent: recent.map((r) => ({
      day: r.day,
      trigger: r.trigger,
      ok: r.ok,
      error: r.error || null,
      pushed: !!(r.gitee && r.gitee.pushed),
      createdAt: r.createdAt,
    })),
  };
};

// 定时触发没有调用方可以看返回值，跑完记一条日志，出了问题事后能查
async function handleTimer(event) {
  await ensureCollection('snapshotLogs');
  const trigger = 'timer';
  try {
    const result = await runSnapshot(trigger);
    await db.collection('snapshotLogs').add({
      data: { ...result, ok: true, createdAt: new Date() },
    });
    console.log('[classmanage] 定时快照完成', result.filePath, result.gitee);
    return { ok: true, data: result };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    await db.collection('snapshotLogs').add({
      data: {
        day: beijingDay(),
        trigger,
        ok: false,
        error: message,
        createdAt: new Date(),
      },
    });
    console.error('[classmanage] 定时快照失败', event && event.TriggerName, message);
    return { ok: false, error: message };
  }
}

exports.main = async (event) => {
  // 定时触发器没有调用方，也没有登录态，单独一条路径处理
  if (event && event.Type === 'timer') return handleTimer(event);

  const { action, ...payload } = event || {};
  const handler = actions[action];
  if (!handler) {
    return { ok: false, error: '未知的操作：' + action };
  }

  try {
    const openid = cloud.getWXContext().OPENID;
    const user = await getCurrentUser(openid);
    const data = await handler({ user, openid, payload });
    return { ok: true, data };
  } catch (err) {
    if (err instanceof BizError) {
      return { ok: false, error: err.message };
    }
    console.error('[classmanage]', action, err);
    return { ok: false, error: '服务异常：' + (err && err.message ? err.message : String(err)) };
  }
};
