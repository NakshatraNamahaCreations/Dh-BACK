const prisma = require('../../config/prisma');
const ApiError = require('../../utils/ApiError');

const shape = (s) => ({
  id: s.id,
  label: s.label,
  startTime: s.startTime,
  endTime: s.endTime,
  capacity: s.capacity,
  icon: s.icon,
  sortOrder: s.sortOrder,
  active: s.active,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

const parseHHmm = (s) => {
  const [h, m] = String(s).split(':').map((n) => parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
};

const validateWindow = (startTime, endTime) => {
  const start = parseHHmm(startTime);
  const end = parseHHmm(endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw ApiError.badRequest('Times must be in HH:mm format');
  }
  // Same-day windows must be strictly increasing. Cross-midnight windows
  // (e.g. 22:00 → 02:00) are not supported here — slots are intended to
  // bucket a single working day.
  if (end <= start) {
    throw ApiError.badRequest('End time must be after start time');
  }
};

exports.list = async ({ activeOnly = false } = {}) => {
  const items = await prisma.timeSlot.findMany({
    where: activeOnly ? { active: true } : undefined,
    orderBy: { sortOrder: 'asc' },
  });
  return items.map(shape);
};

exports.create = async (data) => {
  validateWindow(data.startTime, data.endTime);
  const item = await prisma.timeSlot.create({
    data: {
      label: data.label.trim(),
      startTime: data.startTime,
      endTime: data.endTime,
      capacity: data.capacity ?? 10,
      icon: data.icon ?? 'sunny',
      sortOrder: data.sortOrder ?? 0,
      active: data.active ?? true,
    },
  });
  return shape(item);
};

exports.update = async (id, data) => {
  // If either side of the window is being changed, validate against the
  // resulting pair (i.e. fall back to the existing value for the unchanged
  // side). Cheaper than fetching the row when neither changes.
  if (data.startTime !== undefined || data.endTime !== undefined) {
    let start = data.startTime;
    let end = data.endTime;
    if (start === undefined || end === undefined) {
      const cur = await prisma.timeSlot.findUnique({
        where: { id },
        select: { startTime: true, endTime: true },
      });
      if (!cur) throw ApiError.notFound('Time slot not found');
      if (start === undefined) start = cur.startTime;
      if (end === undefined) end = cur.endTime;
    }
    validateWindow(start, end);
  }

  const patch = {};
  if (data.label !== undefined) patch.label = String(data.label).trim();
  if (data.startTime !== undefined) patch.startTime = data.startTime;
  if (data.endTime !== undefined) patch.endTime = data.endTime;
  if (data.capacity !== undefined) patch.capacity = data.capacity;
  if (data.icon !== undefined) patch.icon = data.icon;
  if (data.sortOrder !== undefined) patch.sortOrder = data.sortOrder;
  if (data.active !== undefined) patch.active = data.active;

  try {
    const item = await prisma.timeSlot.update({ where: { id }, data: patch });
    return shape(item);
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Time slot not found');
    throw err;
  }
};

exports.toggle = async (id) => {
  const cur = await prisma.timeSlot.findUnique({ where: { id }, select: { active: true } });
  if (!cur) throw ApiError.notFound('Time slot not found');
  return exports.update(id, { active: !cur.active });
};

exports.remove = async (id) => {
  try {
    await prisma.timeSlot.delete({ where: { id } });
    return { id };
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.notFound('Time slot not found');
    throw err;
  }
};
