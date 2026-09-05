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
];

const SCORE_TYPES = ['attendance', 'homework', 'exam', 'activity', 'other'];
const REWARD_TYPES = ['一等奖', '二等奖', '三等奖'];
const CERTIFICATE_IMAGES = {
  一等奖: '/images/certificates/certificate_001.jpg',
  二等奖: '/images/certificates/certificate_002.jpg',
  三等奖: '/images/certificates/certificate_003.jpg',
};

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

const SEED_STUDENTS = [
  { name: '示例学生一', studentId: '2000000000001', className: '23秋软件工程班' },
  { name: '示例学生二', studentId: '2000000000002', className: '23秋软件工程班' },
  { name: '示例学生三', studentId: '2000000000003', className: '23秋软件工程班' },
  { name: '示例学生四', studentId: '2000000000004', className: '23秋软件工程班' },
  { name: '示例学生五', studentId: '2000000000005', className: '23秋软件工程班' },
  { name: '示例学生六', studentId: '2000000000006', className: '23秋软件工程班' },
  { name: '示例学生七', studentId: '2000000000007', className: '23秋软件工程班' },
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

  const accounts = [
    { username: 'teacher', password: 'CHANGE_ME', role: 'teacher', studentId: null },
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
  for (const acc of accounts) {
    if (usernames.has(acc.username)) continue;
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

  return { message: '初始化完成', created };
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
  return {
    students: students.map((s) => ({
      ...s,
      totalScore: totals[s.studentId] || 0,
      studentIdAssigned: s.studentIdAssigned !== false,
    })),
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
  const known = new Set(classes.map((c) => c.name));
  const list = classes.map((c) => ({
    _id: c._id,
    name: c.name,
    isArchived: !!c.isArchived,
    startDate: c.startDate || null,
    startSemesterName:
      c.startSemesterId && semesters[c.startSemesterId] ? semesters[c.startSemesterId].name : null,
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
  const cls = await getClassDoc(name);
  if (!cls) fail('班级不存在');

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

// 教师生成短效考勤二维码：同一时刻只保留一个有效码
actions['attendance.createCode'] = async ({ user, payload }) => {
  requireTeacher(user);
  let ttl = Number(payload.ttl) || DEFAULT_CODE_TTL;
  ttl = Math.min(MAX_CODE_TTL, Math.max(MIN_CODE_TTL, Math.round(ttl)));

  const className = String(payload.className || '').trim();
  if (!className) fail('请先选择要考勤的班级');

  const now = new Date();
  // 作废该教师此前尚未过期的考勤码，避免旧二维码被截图复用
  const stale = await db
    .collection('attendanceCodes')
    .where({ createdBy: user.username, revoked: _.neq(true), expireAt: _.gt(now) })
    .get();
  for (const code of stale.data) {
    await db.collection('attendanceCodes').doc(code._id).update({ data: { revoked: true } });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const expireAt = new Date(now.getTime() + ttl * 1000);
  const data = {
    token,
    ttl,
    className,
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
  return {
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

  const day = beijingDay(now);
  const dup = await db
    .collection('scoreRecords')
    .where({ studentId: user.studentId, scoreType: 'attendance', day })
    .count();
  if (dup.total) fail('今日已打卡，每人每天只能打卡一次');

  const record = {
    studentId: user.studentId,
    semesterId: code.semesterId || (await currentSemesterId()),
    scoreType: 'attendance',
    score: 1,
    reason: '扫码考勤打卡',
    operator: user.username,
    timestamp: now,
    day,
    codeId: code._id,
  };
  const added = await db.collection('scoreRecords').add({ data: record });
  await db.collection('attendanceCodes').doc(code._id).update({ data: { checkinCount: _.inc(1) } });

  return {
    message: '打卡成功，考勤加 1 分',
    record: { _id: added._id, ...record, studentName: student.data[0].name },
  };
};

// 教师补录打卡（学生忘带手机等情况）
actions['attendance.manualCheckin'] = async ({ user, payload }) => {
  requireTeacher(user);
  const studentId = String(payload.studentId || '').trim();
  if (!studentId) fail('学号不能为空');

  const student = await db.collection('students').where({ studentId }).limit(1).get();
  if (!student.data.length) fail('学生不存在');

  const now = new Date();
  const day = beijingDay(now);
  const dup = await db
    .collection('scoreRecords')
    .where({ studentId, scoreType: 'attendance', day })
    .count();
  if (dup.total) fail('该学生今日已打卡');

  const record = {
    studentId,
    semesterId: await currentSemesterId(),
    scoreType: 'attendance',
    score: 1,
    reason: '课堂考勤打卡（教师补录）',
    operator: user.username,
    timestamp: now,
    day,
  };
  const added = await db.collection('scoreRecords').add({ data: record });
  return {
    message: '补录成功',
    record: { _id: added._id, ...record, studentName: student.data[0].name },
  };
};

// 今日考勤概况：学生看自己的状态，教师看全班명单
actions['attendance.today'] = async ({ user, payload }) => {
  requireLogin(user);
  const day = beijingDay();
  const records = await fetchAll(
    db.collection('scoreRecords').where({ scoreType: 'attendance', day })
  );

  if (user.role === 'student') {
    const mine = records.find((r) => r.studentId === user.studentId);
    return {
      day,
      checkedIn: !!mine,
      timestamp: mine ? mine.timestamp : null,
      via: mine ? mine.reason : null,
    };
  }

  const className = await resolveClassName(user, payload);
  const list = await fetchAll(
    className
      ? db.collection('students').where({ className }).orderBy('name', 'asc')
      : db.collection('students').orderBy('className', 'asc')
  );
  const byId = {};
  for (const r of records) byId[r.studentId] = r;
  return {
    day,
    className,
    total: list.length,
    checkedInCount: list.filter((s) => byId[s.studentId]).length,
    students: list.map((s) => ({
      studentId: s.studentId,
      name: s.name,
      className: s.className,
      studentIdAssigned: s.studentIdAssigned !== false,
      phone: s.phone || null,
      checkedIn: !!byId[s.studentId],
      timestamp: byId[s.studentId] ? byId[s.studentId].timestamp : null,
      reason: byId[s.studentId] ? byId[s.studentId].reason : null,
    })),
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

exports.main = async (event) => {
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
