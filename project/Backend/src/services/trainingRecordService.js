import { z } from 'zod';
import prisma from '../prisma/client';
import { NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors';

const trainingRecordSchema = z.object({
  employeeId: z.string().uuid(),
  programId: z.string().uuid(),
  status: z.enum(['REGISTERED', 'IN_PROGRESS', 'COMPLETED']).optional(),
});

export const getTrainingRecords = async ({ userRole, userId, page = 1, limit = 10, employeeId, programId }) => {
  if (!['ADMIN', 'HR', 'EMPLOYEE'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const skip = (page - 1) * limit;
  const where = { employeeId, programId };
  if (userRole === 'EMPLOYEE') where.employeeId = userId;
  return prisma.trainingRecord.findMany({
    where,
    skip,
    take: limit,
    include: { employee: true, program: true },
  });
};

export const getTrainingRecordById = async ({ id, userRole, userId }) => {
  if (!['ADMIN', 'HR', 'EMPLOYEE'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const record = await prisma.trainingRecord.findUnique({
    where: { id },
    include: { employee: true, program: true },
  });
  if (!record) throw new NotFoundError('Training record not found');
  if (userRole === 'EMPLOYEE' && record.employeeId !== userId) throw new UnauthorizedError('Unauthorized');
  return record;
};

export const createTrainingRecord = async ({ data, userRole }) => {
  if (!['ADMIN', 'HR'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const validatedData = trainingRecordSchema.parse(data);
  const employee = await prisma.employee.findUnique({ where: { id: validatedData.employeeId } });
  if (!employee) throw new ValidationError('Invalid employeeId');
  const program = await prisma.trainingProgram.findUnique({ where: { id: validatedData.programId } });
  if (!program) throw new ValidationError('Invalid programId');
  return prisma.trainingRecord.create({ data: validatedData });
};

export const updateTrainingRecord = async ({ id, data, userRole }) => {
  if (!['ADMIN', 'HR'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const validatedData = trainingRecordSchema.partial().parse(data);
  const record = await prisma.trainingRecord.findUnique({ where: { id } });
  if (!record) throw new NotFoundError('Training record not found');
  return prisma.trainingRecord.update({ where: { id }, data: validatedData });
};

export const deleteTrainingRecord = async ({ id, userRole }) => {
  if (!['ADMIN', 'HR'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const record = await prisma.trainingRecord.findUnique({ where: { id } });
  if (!record) throw new NotFoundError('Training record not found');
  return prisma.trainingRecord.delete({ where: { id } });
};