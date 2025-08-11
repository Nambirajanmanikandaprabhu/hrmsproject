import express from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';
import { AppError, ValidationError } from '../utils/errors.js';
import prisma from '../config/prisma.js';

const router = express.Router();

// Validation schemas
const onboardingTaskSchemas = {
  create: z.object({
    body: z.object({
      templateId: z.string().uuid('Invalid template ID').optional(),
      employeeId: z.string().uuid('Invalid employee ID').optional(),
      assigneeId: z.string().uuid('Invalid assignee ID').optional(),
      title: z.string().min(1, 'Title is required'),
      description: z.string().optional(),
      dueDate: z.string().datetime().optional(),
      sortOrder: z.number().min(0).optional().default(0),
    }),
  }),
  update: z.object({
    params: z.object({ id: z.string().uuid('Invalid task ID') }),
    body: z.object({
      title: z.string().min(1, 'Title is required').optional(),
      description: z.string().optional(),
      dueDate: z.string().datetime().optional(),
      status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
      notes: z.string().optional(),
      sortOrder: z.number().min(0).optional(),
      completedAt: z.string().datetime().optional(),
    }),
  }),
  getAll: z.object({
    query: z.object({
      page: z.string().regex(/^\d+$/).optional().default('1'),
      limit: z.string().regex(/^\d+$/).optional().default('10'),
      employeeId: z.string().uuid('Invalid employee ID').optional(),
      templateId: z.string().uuid('Invalid template ID').optional(),
      status: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']).optional(),
    }),
  }),
};

// GET / - List tasks
router.get('/', authenticate, authorize('ADMIN', 'HR', 'EMPLOYEE'), validate(onboardingTaskSchemas.getAll), async (req, res, next) => {
  try {
    const { page, limit, employeeId, templateId, status } = req.validatedData.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const where = {};
    if (employeeId) where.employeeId = employeeId;
    if (templateId) where.templateId = templateId;
    if (status) where.status = status;

    // Apply role-based filtering
    if (req.user.role === 'EMPLOYEE') {
      where.employeeId = req.user.employee?.id;
    }

    const [tasks, total] = await Promise.all([
      prisma.onboardingTask.findMany({
        where,
        skip,
        take: parseInt(limit),
        include: {
          template: {
            select: { id: true, name: true },
          },
          employee: {
            select: { id: true, firstName: true, lastName: true, employeeId: true },
          },
          assignee: {
            select: { id: true, firstName: true, lastName: true },
          },
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      prisma.onboardingTask.count({ where }),
    ]);

    await createAuditLog(req.user.id, 'READ', 'onboarding_tasks', null, null, null, req);

    res.json({
      success: true,
      data: {
        tasks,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / parseInt(limit)),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /:id - Get task details
router.get('/:id', authenticate, authorize('ADMIN', 'HR', 'EMPLOYEE'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const task = await prisma.onboardingTask.findUnique({
      where: { id },
      include: {
        template: {
          select: { id: true, name: true, description: true },
        },
        employee: {
          select: { id: true, firstName: true, lastName: true, employeeId: true },
        },
        assignee: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    if (!task) throw new AppError('Onboarding task not found', 404);

    // Check access permissions for employees
    if (req.user.role === 'EMPLOYEE' && req.user.employee?.id !== task.employeeId) {
      throw new AppError('Access denied', 403);
    }

    await createAuditLog(req.user.id, 'READ', 'onboarding_tasks', id, null, null, req);

    res.json({ success: true, data: { task } });
  } catch (error) {
    next(error);
  }
});

// POST / - Create task
router.post('/', authenticate, authorize('ADMIN', 'HR'), validate(onboardingTaskSchemas.create), async (req, res, next) => {
  try {
    const { templateId, employeeId, assigneeId, title, description, dueDate, sortOrder } = req.validatedData.body;

    // Validate template exists if provided
    if (templateId) {
      const template = await prisma.onboardingTemplate.findUnique({
        where: { id: templateId, isActive: true },
      });
      if (!template) throw new ValidationError('Onboarding template not found or inactive');
    }

    // Validate employee exists if provided
    if (employeeId) {
      const employee = await prisma.employee.findUnique({
        where: { id: employeeId, employmentStatus: 'ACTIVE' },
      });
      if (!employee) throw new ValidationError('Employee not found or inactive');
    }

    // Validate assignee exists if provided
    if (assigneeId) {
      const assignee = await prisma.employee.findUnique({
        where: { id: assigneeId, employmentStatus: 'ACTIVE' },
      });
      if (!assignee) throw new ValidationError('Assignee not found or inactive');
    }

    const task = await prisma.onboardingTask.create({
      data: {
        templateId,
        employeeId,
        assigneeId,
        title,
        description,
        dueDate: dueDate ? new Date(dueDate) : null,
        sortOrder,
        status: 'PENDING',
      },
      include: {
        template: {
          select: { id: true, name: true },
        },
        employee: {
          select: { id: true, firstName: true, lastName: true, employeeId: true },
        },
        assignee: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    await createAuditLog(req.user.id, 'CREATE', 'onboarding_tasks', task.id, null, task, req);

    res.status(201).json({
      success: true,
      message: 'Onboarding task created successfully',
      data: { task },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /:id - Update task
router.put('/:id', authenticate, authorize('ADMIN', 'HR'), validate(onboardingTaskSchemas.update), async (req, res, next) => {
  try {
    const { id } = req.validatedData.params;
    const updateData = req.validatedData.body;

    const existingTask = await prisma.onboardingTask.findUnique({ where: { id } });
    if (!existingTask) throw new AppError('Onboarding task not found', 404);

    // Handle status changes
    if (updateData.status === 'COMPLETED' && !updateData.completedAt) {
      updateData.completedAt = new Date();
    }

    const formattedData = {
      ...updateData,
      dueDate: updateData.dueDate ? new Date(updateData.dueDate) : undefined,
      completedAt: updateData.completedAt ? new Date(updateData.completedAt) : undefined,
    };

    const task = await prisma.onboardingTask.update({
      where: { id },
      data: formattedData,
      include: {
        template: {
          select: { id: true, name: true },
        },
        employee: {
          select: { id: true, firstName: true, lastName: true, employeeId: true },
        },
        assignee: {
          select: { id: true, firstName: true, lastName: true },
        },
      },
    });

    await createAuditLog(req.user.id, 'UPDATE', 'onboarding_tasks', id, existingTask, task, req);

    res.json({
      success: true,
      message: 'Onboarding task updated successfully',
      data: { task },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /:id - Delete task
router.delete('/:id', authenticate, authorize('ADMIN', 'HR'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existingTask = await prisma.onboardingTask.findUnique({ where: { id } });
    if (!existingTask) throw new AppError('Onboarding task not found', 404);

    await prisma.onboardingTask.delete({ where: { id } });

    await createAuditLog(req.user.id, 'DELETE', 'onboarding_tasks', id, existingTask, null, req);

    res.json({
      success: true,
      message: 'Onboarding task deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
