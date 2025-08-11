import { z } from 'zod';
import prisma from '../prisma/client';
import { NotFoundError, UnauthorizedError } from '../utils/errors';

const trainingProgramSchema = z.object({
  name: z.string().min(1),
  isActive: z.boolean().optional(),
});

export const getTrainingPrograms = async ({ userRole, page = 1, limit = 10, isActive }) => {
  if (!['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const skip = (page - 1) * limit;
  return prisma.trainingProgram.findMany({
    where: { isActive: isActive !== undefined ? isActive : undefined },
    skip,
    take: limit,
  });
};

export const getTrainingProgramById = async ({ id, userRole }) => {
  if (!['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const program = await prisma.trainingProgram.findUnique({ where: { id } });
  if (!program) throw new NotFoundError('Training program not found');
  return program;
};

export const createTrainingProgram = async ({ data, userRole }) => {
  if (!['ADMIN', 'HR'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const validatedData = trainingProgramSchema.parse(data);
  return prisma.trainingProgram.create({ data: { ...validatedData, isActive: true } });
};

export const updateTrainingProgram = async ({ id, data, userRole }) => {
  if (!['ADMIN', 'HR'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const validatedData = trainingProgramSchema.partial().parse(data);
  const program = await prisma.trainingProgram.findUnique({ where: { id } });
  if (!program) throw new NotFoundError('Training program not found');
  return prisma.trainingProgram.update({ where: { id }, data: validatedData });
};

export const deleteTrainingProgram = async ({ id, userRole }) => {
  if (!['ADMIN', 'HR'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const program = await prisma.trainingProgram.findUnique({ where: { id } });
  if (!program) throw new NotFoundError('Training program not found');
  return prisma.trainingProgram.update({ where: { id }, data: { isActive: false } });
};