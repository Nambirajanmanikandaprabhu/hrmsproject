import { z } from 'zod';
import prisma from '../prisma/client';
import { NotFoundError, UnauthorizedError, ValidationError } from '../utils/errors';

const documentSchema = z.object({
  employeeId: z.string().uuid().optional(),
  fileName: z.string().min(1),
  documentType: z.enum(['RESUME', 'CONTRACT', 'ID_PROOF', 'CERTIFICATE']),
});

export const getDocuments = async ({ userRole, userId, page = 1, limit = 10, employeeId, documentType }) => {
  if (!['ADMIN', 'HR', 'EMPLOYEE'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const skip = (page - 1) * limit;
  const where = { employeeId, documentType };
  if (userRole === 'EMPLOYEE') where.employeeId = userId;
  return prisma.document.findMany({
    where,
    skip,
    take: limit,
    include: { employee: true },
  });
};

export const getDocumentById = async ({ id, userRole, userId }) => {
  if (!['ADMIN', 'HR', 'EMPLOYEE'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const document = await prisma.document.findUnique({
    where: { id },
    include: { employee: true },
  });
  if (!document) throw new NotFoundError('Document not found');
  if (userRole === 'EMPLOYEE' && document.employeeId !== userId) throw new UnauthorizedError('Unauthorized');
  return document;
};

export const createDocument = async ({ data, userRole, userId }) => {
  if (!['ADMIN', 'HR', 'EMPLOYEE'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const validatedData = documentSchema.parse(data);
  if (validatedData.employeeId) {
    const employee = await prisma.employee.findUnique({ where: { id: validatedData.employeeId } });
    if (!employee) throw new ValidationError('Invalid employeeId');
    if (userRole === 'EMPLOYEE' && validatedData.employeeId !== userId) throw new UnauthorizedError('Unauthorized');
  }
  return prisma.document.create({ data: validatedData });
};

export const updateDocument = async ({ id, data, userRole }) => {
  if (!['ADMIN', 'HR'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const validatedData = documentSchema.partial().parse(data);
  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) throw new NotFoundError('Document not found');
  return prisma.document.update({ where: { id }, data: validatedData });
};

export const deleteDocument = async ({ id, userRole }) => {
  if (!['ADMIN', 'HR'].includes(userRole)) throw new UnauthorizedError('Unauthorized');
  const document = await prisma.document.findUnique({ where: { id } });
  if (!document) throw new NotFoundError('Document not found');
  return prisma.document.delete({ where: { id } });
};