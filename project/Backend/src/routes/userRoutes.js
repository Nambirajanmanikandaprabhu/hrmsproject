import express from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';
import { userService } from '../services/userService.js';
import { AppError } from '../utils/errors.js';

const prisma = new PrismaClient();
const router = express.Router();

// Validation schemas
const userSchemas = {
  create: z.object({
    body: z.object({
      email: z.string().email('Invalid email format'),
      password: z.string().min(8, 'Password must be at least 8 characters'),
      role: z.enum(['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE']),
      employeeId: z.string().uuid().optional(),
    }),
  }),
  update: z.object({
    params: z.object({ id: z.string().uuid('Invalid user ID') }),
    body: z.object({
      email: z.string().email().optional(),
      role: z.enum(['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE']).optional(),
      isActive: z.boolean().optional(),
      employeeId: z.string().uuid().optional(),
    }),
  }),
  getAll: z.object({
    query: z.object({
      page: z.string().regex(/^\d+$/).optional().default('1'),
      limit: z.string().regex(/^\d+$/).optional().default('10'),
      search: z.string().optional(),
      role: z.enum(['ADMIN', 'HR', 'MANAGER', 'EMPLOYEE']).optional(),
      isActive: z.enum(['true', 'false']).optional(),
    }),
  }),
  changePassword: z.object({
    body: z.object({
      currentPassword: z.string().min(1, 'Current password is required'),
      newPassword: z.string().min(8, 'New password must be at least 8 characters'),
    }),
  }),
  resetPasswordRequest: z.object({
    body: z.object({
      email: z.string().email('Invalid email format'),
    }),
  }),
  resetPassword: z.object({
    body: z.object({
      token: z.string().uuid(),
      newPassword: z.string().min(8, 'New password must be at least 8 characters'),
    }),
  }),
};

// Get all users
router.get('/', authenticate, authorize('ADMIN', 'HR'), validate(userSchemas.getAll), async (req, res, next) => {
  try {
    const { page, limit, search, role, isActive } = req.validatedData.query;
    const users = await userService.getAllUsers({
      page: parseInt(page),
      limit: parseInt(limit),
      search,
      role,
      isActive,
    });

    await createAuditLog(req.user.id, 'READ', 'users', null, null, null, req);

    res.json({ success: true, message: 'Users fetched successfully', data: users });
  } catch (error) {
    next(error);
  }
});

// Get single user
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;

    if (id !== req.user.id && !['ADMIN', 'HR'].includes(req.user.role)) {
      throw new AppError('Unauthorized access', 403);
    }

    const user = await userService.getUser(id);
    if (!user) throw new AppError('User not found', 404);

    await createAuditLog(req.user.id, 'READ', 'users', id, null, null, req);

    res.json({ success: true, message: 'User fetched successfully', data: { user } });
  } catch (error) {
    next(error);
  }
});

// Create user
router.post('/', authenticate, authorize('ADMIN', 'HR'), validate(userSchemas.create), async (req, res, next) => {
  try {
    const user = await userService.createUser({ ...req.validatedData.body, createdById: req.user.id }, req);
    res.status(201).json({ success: true, message: 'User created successfully', data: { user } });
  } catch (error) {
    next(error);
  }
});

// Update user
router.put('/:id', authenticate, authorize('ADMIN', 'HR'), validate(userSchemas.update), async (req, res, next) => {
  try {
    const { id } = req.validatedData.params;
    const user = await userService.updateUser(id, req.validatedData.body, req);
    res.json({ success: true, message: 'User updated successfully', data: { user } });
  } catch (error) {
    next(error);
  }
});

// Change own password
router.patch('/change-password', authenticate, validate(userSchemas.changePassword), async (req, res, next) => {
  try {
    await userService.changePassword(req.user.id, req.validatedData.body, req);
    res.json({ success: true, message: 'Password changed successfully' });
  } catch (error) {
    next(error);
  }
});

// Request password reset
router.post('/reset-password-request', validate(userSchemas.resetPasswordRequest), async (req, res, next) => {
  try {
    await userService.requestPasswordReset(req.validatedData.body.email);
    res.json({ success: true, message: 'Reset token sent' });
  } catch (error) {
    next(error);
  }
});

// Reset password with token
router.patch('/reset-password', validate(userSchemas.resetPassword), async (req, res, next) => {
  try {
    await userService.resetPassword(req.validatedData.body, req);
    res.json({ success: true, message: 'Password reset successfully' });
  } catch (error) {
    next(error);
  }
});

// Delete user (soft delete)
router.delete('/:id', authenticate, authorize('ADMIN'), async (req, res, next) => {
  try {
    const { id } = req.params;
    await userService.deleteUser(id, req);
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// Get user activity logs
router.get('/:id/activity', authenticate, authorize('ADMIN', 'HR'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const activities = await userService.getUserActivity(id, { page, limit });

    await createAuditLog(req.user.id, 'READ', 'audit_logs', id, null, null, req);

    res.json({ success: true, message: 'Activity logs fetched successfully', data: activities });
  } catch (error) {
    next(error);
  }
});

export default router;
