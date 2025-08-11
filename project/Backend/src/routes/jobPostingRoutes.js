import express from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';
import { AppError, ValidationError } from '../utils/errors.js';
import prisma from '../config/prisma.js';

const router = express.Router();

// Validation schema
const jobPostingSchemas = {
  create: z.object({
    body: z.object({
      title: z.string().min(1, 'Title is required'),
      description: z.string().min(1, 'Description is required'),
      requirements: z.array(z.string()).optional().default([]),
      departmentId: z.string().uuid('Invalid department ID').optional(),
      positionId: z.string().uuid('Invalid position ID').optional(),
      salaryMin: z.number().min(0).optional(),
      salaryMax: z.number().min(0).optional(),
      location: z.string().optional(),
      employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'CONSULTANT']).default('FULL_TIME'),
      status: z.enum(['OPEN', 'IN_PROGRESS', 'ON_HOLD', 'CLOSED', 'CANCELLED']).default('OPEN'),
      expiresAt: z.string().datetime().optional(),
    }),
  }),
  update: z.object({
    params: z.object({ id: z.string().uuid('Invalid job posting ID') }),
    body: z.object({
      title: z.string().min(1, 'Title is required').optional(),
      description: z.string().min(1, 'Description is required').optional(),
      requirements: z.array(z.string()).optional(),
      departmentId: z.string().uuid('Invalid department ID').optional(),
      positionId: z.string().uuid('Invalid position ID').optional(),
      salaryMin: z.number().min(0).optional(),
      salaryMax: z.number().min(0).optional(),
      location: z.string().optional(),
      employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'CONSULTANT']).optional(),
      status: z.enum(['OPEN', 'IN_PROGRESS', 'ON_HOLD', 'CLOSED', 'CANCELLED']).optional(),
      expiresAt: z.string().datetime().optional(),
    }),
  }),
  getAll: z.object({
    query: z.object({
      page: z.string().regex(/^\d+$/).optional().default('1'),
      limit: z.string().regex(/^\d+$/).optional().default('10'),
      status: z.enum(['OPEN', 'IN_PROGRESS', 'ON_HOLD', 'CLOSED', 'CANCELLED']).optional(),
      departmentId: z.string().uuid().optional(),
      employmentType: z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN', 'CONSULTANT']).optional(),
    }),
  }),
};

// GET / - List job postings (public for job seekers, authenticated for internal users)
router.get('/', validate(jobPostingSchemas.getAll), async (req, res, next) => {
  try {
    const { page, limit, status, departmentId, employmentType } = req.validatedData.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const where = {};
    if (status) where.status = status;
    if (departmentId) where.departmentId = departmentId;
    if (employmentType) where.employmentType = employmentType;
    
    // For public access, only show open positions
    if (!req.user) {
      where.status = 'OPEN';
      where.expiresAt = { gte: new Date() };
    }

    const [postings, total] = await Promise.all([
      prisma.jobPosting.findMany({
        where,
        skip,
        take: parseInt(limit),
        include: {
          department: {
            select: { id: true, name: true },
          },
          position: {
            select: { id: true, title: true, level: true },
          },
          _count: {
            select: { applications: true },
          },
        },
        orderBy: { postedAt: 'desc' },
      }),
      prisma.jobPosting.count({ where }),
    ]);

    if (req.user) {
      await createAuditLog(req.user.id, 'READ', 'job_postings', null, null, null, req);
    }

    res.json({
      success: true,
      data: {
        postings,
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

// GET /:id - Get job posting details (public)
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const posting = await prisma.jobPosting.findUnique({
      where: { id },
      include: {
        department: {
          select: { id: true, name: true },
        },
        position: {
          select: { id: true, title: true, level: true, description: true },
        },
        applications: req.user && ['ADMIN', 'HR'].includes(req.user.role) ? {
          select: { id: true, firstName: true, lastName: true, email: true, status: true, appliedAt: true },
          orderBy: { appliedAt: 'desc' },
        } : false,
      },
    });

    if (!posting) throw new AppError('Job posting not found', 404);

    // For public access, only show open positions that haven't expired
    if (!req.user && (posting.status !== 'OPEN' || (posting.expiresAt && posting.expiresAt < new Date()))) {
      throw new AppError('Job posting not found', 404);
    }

    if (req.user) {
      await createAuditLog(req.user.id, 'READ', 'job_postings', id, null, null, req);
    }

    res.json({ success: true, data: { posting } });
  } catch (error) {
    next(error);
  }
});

// POST / - Create job posting
router.post('/', authenticate, authorize('ADMIN', 'HR'), validate(jobPostingSchemas.create), async (req, res, next) => {
  try {
    const postingData = req.validatedData.body;

    // Validate department exists if provided
    if (postingData.departmentId) {
      const department = await prisma.department.findUnique({
        where: { id: postingData.departmentId, isActive: true },
      });
      if (!department) throw new ValidationError('Department not found or inactive');
    }

    // Validate position exists if provided
    if (postingData.positionId) {
      const position = await prisma.position.findUnique({
        where: { id: postingData.positionId, isActive: true },
      });
      if (!position) throw new ValidationError('Position not found or inactive');
    }

    // Validate salary range
    if (postingData.salaryMin && postingData.salaryMax && postingData.salaryMin > postingData.salaryMax) {
      throw new ValidationError('Minimum salary cannot be greater than maximum salary');
    }

    const formattedData = {
      ...postingData,
      expiresAt: postingData.expiresAt ? new Date(postingData.expiresAt) : null,
    };

    const posting = await prisma.jobPosting.create({
      data: formattedData,
      include: {
        department: {
          select: { id: true, name: true },
        },
        position: {
          select: { id: true, title: true, level: true },
        },
      },
    });

    await createAuditLog(req.user.id, 'CREATE', 'job_postings', posting.id, null, posting, req);

    res.status(201).json({
      success: true,
      message: 'Job posting created successfully',
      data: { posting },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /:id - Update job posting
router.put('/:id', authenticate, authorize('ADMIN', 'HR'), validate(jobPostingSchemas.update), async (req, res, next) => {
  try {
    const { id } = req.validatedData.params;
    const updateData = req.validatedData.body;

    const existingPosting = await prisma.jobPosting.findUnique({ where: { id } });
    if (!existingPosting) throw new AppError('Job posting not found', 404);

    // Validate department exists if provided
    if (updateData.departmentId) {
      const department = await prisma.department.findUnique({
        where: { id: updateData.departmentId, isActive: true },
      });
      if (!department) throw new ValidationError('Department not found or inactive');
    }

    // Validate position exists if provided
    if (updateData.positionId) {
      const position = await prisma.position.findUnique({
        where: { id: updateData.positionId, isActive: true },
      });
      if (!position) throw new ValidationError('Position not found or inactive');
    }

    // Validate salary range
    const salaryMin = updateData.salaryMin !== undefined ? updateData.salaryMin : existingPosting.salaryMin;
    const salaryMax = updateData.salaryMax !== undefined ? updateData.salaryMax : existingPosting.salaryMax;
    if (salaryMin && salaryMax && salaryMin > salaryMax) {
      throw new ValidationError('Minimum salary cannot be greater than maximum salary');
    }

    const formattedData = {
      ...updateData,
      expiresAt: updateData.expiresAt ? new Date(updateData.expiresAt) : undefined,
      closedAt: updateData.status === 'CLOSED' ? new Date() : undefined,
    };

    const posting = await prisma.jobPosting.update({
      where: { id },
      data: formattedData,
      include: {
        department: {
          select: { id: true, name: true },
        },
        position: {
          select: { id: true, title: true, level: true },
        },
      },
    });

    await createAuditLog(req.user.id, 'UPDATE', 'job_postings', id, existingPosting, posting, req);

    res.json({
      success: true,
      message: 'Job posting updated successfully',
      data: { posting },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /:id - Delete job posting
router.delete('/:id', authenticate, authorize('ADMIN', 'HR'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existingPosting = await prisma.jobPosting.findUnique({
      where: { id },
      include: {
        applications: true,
      },
    });

    if (!existingPosting) throw new AppError('Job posting not found', 404);

    // Check if there are applications
    if (existingPosting.applications.length > 0) {
      throw new ValidationError('Cannot delete job posting with applications. Close it instead.');
    }

    await prisma.jobPosting.delete({ where: { id } });

    await createAuditLog(req.user.id, 'DELETE', 'job_postings', id, existingPosting, null, req);

    res.json({
      success: true,
      message: 'Job posting deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
