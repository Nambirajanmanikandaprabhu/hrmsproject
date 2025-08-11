import express from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';
import { AppError, ValidationError } from '../utils/errors.js';
import prisma from '../config/prisma.js';

const router = express.Router();

// Validation Schemas
const interviewSchemas = {
  create: z.object({
    body: z.object({
      applicationId: z.string().uuid('Invalid application ID'),
      scheduledAt: z.string().datetime('Invalid date format'),
      duration: z.number().min(15, 'Duration must be at least 15 minutes').default(60),
      location: z.string().optional(),
      type: z.string().optional(),
      interviewers: z.array(z.string()).optional().default([]),
    }),
  }),
  update: z.object({
    params: z.object({ id: z.string().uuid('Invalid interview ID') }),
    body: z.object({
      scheduledAt: z.string().datetime('Invalid date format').optional(),
      duration: z.number().min(15, 'Duration must be at least 15 minutes').optional(),
      location: z.string().optional(),
      type: z.string().optional(),
      interviewers: z.array(z.string()).optional(),
      status: z.enum(['scheduled', 'completed', 'cancelled', 'rescheduled']).optional(),
      feedback: z.string().optional(),
      rating: z.number().min(1).max(5).optional(),
    }),
  }),
  getAll: z.object({
    query: z.object({
      page: z.string().regex(/^\d+$/).optional().default('1'),
      limit: z.string().regex(/^\d+$/).optional().default('10'),
      applicationId: z.string().uuid('Invalid application ID').optional(),
      status: z.enum(['scheduled', 'completed', 'cancelled', 'rescheduled']).optional(),
    }),
  }),
};

// GET / - List interviews
router.get('/', authenticate, authorize('ADMIN', 'HR'), validate(interviewSchemas.getAll), async (req, res, next) => {
  try {
    const { page, limit, applicationId, status } = req.validatedData.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const where = {};
    if (applicationId) where.applicationId = applicationId;
    if (status) where.status = status;

    const [interviews, total] = await Promise.all([
      prisma.interview.findMany({
        where,
        skip,
        take: parseInt(limit),
        include: {
          application: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
              jobPosting: {
                select: { id: true, title: true },
              },
            },
          },
        },
        orderBy: { scheduledAt: 'asc' },
      }),
      prisma.interview.count({ where }),
    ]);

    await createAuditLog(req.user.id, 'READ', 'interviews', null, null, null, req);

    res.json({
      success: true,
      data: {
        interviews,
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

// GET /:id - Get interview details
router.get('/:id', authenticate, authorize('ADMIN', 'HR'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const interview = await prisma.interview.findUnique({
      where: { id },
      include: {
        application: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            phone: true,
            resumeUrl: true,
            jobPosting: {
              select: { id: true, title: true, description: true },
            },
          },
        },
      },
    });

    if (!interview) throw new AppError('Interview not found', 404);

    await createAuditLog(req.user.id, 'READ', 'interviews', id, null, null, req);

    res.json({
      success: true,
      data: { interview },
    });
  } catch (error) {
    next(error);
  }
});

// POST / - Create interview
router.post('/', authenticate, authorize('ADMIN', 'HR'), validate(interviewSchemas.create), async (req, res, next) => {
  try {
    const { applicationId, scheduledAt, duration, location, type, interviewers } = req.validatedData.body;

    // Validate application exists
    const application = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
    });
    if (!application) throw new ValidationError('Job application not found');

    // Validate scheduled time is in the future
    const scheduleDate = new Date(scheduledAt);
    if (scheduleDate <= new Date()) {
      throw new ValidationError('Interview must be scheduled for a future date and time');
    }

    const interview = await prisma.interview.create({
      data: {
        applicationId,
        scheduledAt: scheduleDate,
        duration,
        location,
        type,
        interviewers,
        status: 'scheduled',
      },
      include: {
        application: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            jobPosting: {
              select: { id: true, title: true },
            },
          },
        },
      },
    });

    await createAuditLog(req.user.id, 'CREATE', 'interviews', interview.id, null, interview, req);

    res.status(201).json({
      success: true,
      message: 'Interview scheduled successfully',
      data: { interview },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /:id - Update interview
router.put('/:id', authenticate, authorize('ADMIN', 'HR'), validate(interviewSchemas.update), async (req, res, next) => {
  try {
    const { id } = req.validatedData.params;
    const updateData = req.validatedData.body;

    const existingInterview = await prisma.interview.findUnique({ where: { id } });
    if (!existingInterview) throw new AppError('Interview not found', 404);

    // Validate scheduled time is in the future if being updated
    if (updateData.scheduledAt) {
      const scheduleDate = new Date(updateData.scheduledAt);
      if (scheduleDate <= new Date()) {
        throw new ValidationError('Interview must be scheduled for a future date and time');
      }
      updateData.scheduledAt = scheduleDate;
    }

    const interview = await prisma.interview.update({
      where: { id },
      data: updateData,
      include: {
        application: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            jobPosting: {
              select: { id: true, title: true },
            },
          },
        },
      },
    });

    await createAuditLog(req.user.id, 'UPDATE', 'interviews', id, existingInterview, interview, req);

    res.json({
      success: true,
      message: 'Interview updated successfully',
      data: { interview },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /:id - Delete interview
router.delete('/:id', authenticate, authorize('ADMIN', 'HR'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existingInterview = await prisma.interview.findUnique({ where: { id } });
    if (!existingInterview) throw new AppError('Interview not found', 404);

    await prisma.interview.delete({ where: { id } });

    await createAuditLog(req.user.id, 'DELETE', 'interviews', id, existingInterview, null, req);

    // Placeholder (replace with Prisma)
    res.json({
      success: true,
      message: 'Interview deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
