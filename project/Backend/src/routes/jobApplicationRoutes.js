import express from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';
import { AppError, ValidationError } from '../utils/errors.js';
import prisma from '../config/prisma.js';

const router = express.Router();

// Validation Schemas
const jobApplicationSchemas = {
  create: z.object({
    body: z.object({
      jobPostingId: z.string().uuid('Invalid job posting ID'),
      firstName: z.string().min(1, 'First name is required'),
      lastName: z.string().min(1, 'Last name is required'),
      email: z.string().email('Invalid email'),
      phone: z.string().optional(),
      resumeUrl: z.string().url().optional(),
      coverLetter: z.string().optional(),
    }),
  }),
  update: z.object({
    params: z.object({ id: z.string().uuid('Invalid application ID') }),
    body: z.object({
      status: z.enum(['APPLIED', 'SCREENING', 'INTERVIEW', 'ASSESSMENT', 'OFFER', 'HIRED', 'REJECTED']).optional(),
      notes: z.string().optional(),
      rating: z.number().min(1).max(5).optional(),
      screenedAt: z.string().datetime().optional(),
      interviewedAt: z.string().datetime().optional(),
    }),
  }),
  getAll: z.object({
    query: z.object({
      page: z.string().regex(/^\d+$/).optional().default('1'),
      limit: z.string().regex(/^\d+$/).optional().default('10'),
      jobPostingId: z.string().uuid('Invalid job posting ID').optional(),
      status: z.enum(['APPLIED', 'SCREENING', 'INTERVIEW', 'ASSESSMENT', 'OFFER', 'HIRED', 'REJECTED']).optional(),
    }),
  }),
};

// GET / - List applications (HR/Admin only)
router.get('/', authenticate, authorize('ADMIN', 'HR'), validate(jobApplicationSchemas.getAll), async (req, res, next) => {
  try {
    const { page, limit, jobPostingId, status } = req.validatedData.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const where = {};
    if (jobPostingId) where.jobPostingId = jobPostingId;
    if (status) where.status = status;

    const [applications, total] = await Promise.all([
      prisma.jobApplication.findMany({
        where,
        skip,
        take: parseInt(limit),
        include: {
          jobPosting: {
            select: { id: true, title: true, department: { select: { name: true } } },
          },
          interviews: {
            select: { id: true, scheduledAt: true, status: true },
            orderBy: { scheduledAt: 'desc' },
          },
        },
        orderBy: { appliedAt: 'desc' },
      }),
      prisma.jobApplication.count({ where }),
    ]);

    await createAuditLog(req.user.id, 'READ', 'job_applications', null, null, null, req);

    res.json({
      success: true,
      data: {
        applications,
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

// GET /:id - Get application details (HR/Admin only)
router.get('/:id', authenticate, authorize('ADMIN', 'HR'), async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const application = await prisma.jobApplication.findUnique({
      where: { id },
      include: {
        jobPosting: {
          select: { id: true, title: true, description: true, department: { select: { name: true } } },
        },
        interviews: {
          select: { id: true, scheduledAt: true, duration: true, location: true, type: true, status: true, feedback: true, rating: true },
          orderBy: { scheduledAt: 'desc' },
        },
      },
    });

    if (!application) throw new AppError('Job application not found', 404);

    await createAuditLog(req.user.id, 'READ', 'job_applications', id, null, null, req);

    res.json({ success: true, data: { application } });
  } catch (error) {
    next(error);
  }
});

// POST / - Create application (public endpoint)
router.post('/', validate(jobApplicationSchemas.create), async (req, res, next) => {
  try {
    const { jobPostingId, firstName, lastName, email, phone, resumeUrl, coverLetter } = req.validatedData.body;

    // Validate job posting exists and is open
    const jobPosting = await prisma.jobPosting.findUnique({
      where: { id: jobPostingId },
    });

    if (!jobPosting) throw new ValidationError('Job posting not found');
    if (jobPosting.status !== 'OPEN') throw new ValidationError('Job posting is not accepting applications');
    if (jobPosting.expiresAt && jobPosting.expiresAt < new Date()) {
      throw new ValidationError('Job posting has expired');
    }

    // Check for duplicate application
    const existingApplication = await prisma.jobApplication.findFirst({
      where: { jobPostingId, email },
    });
    if (existingApplication) {
      throw new ValidationError('You have already applied for this position');
    }

    const application = await prisma.jobApplication.create({
      data: {
        jobPostingId,
        firstName,
        lastName,
        email,
        phone,
        resumeUrl,
        coverLetter,
        status: 'APPLIED',
      },
      include: {
        jobPosting: {
          select: { id: true, title: true },
        },
      },
    });

    res.status(201).json({
      success: true,
      message: 'Application submitted successfully',
      data: { application },
    });
  } catch (error) {
    next(error);
  }
});

// PUT /:id - Update application (HR/Admin only)
router.put('/:id', authenticate, authorize('ADMIN', 'HR'), validate(jobApplicationSchemas.update), async (req, res, next) => {
  try {
    const { id } = req.validatedData.params;
    const updateData = req.validatedData.body;

    const existingApplication = await prisma.jobApplication.findUnique({ where: { id } });
    if (!existingApplication) throw new AppError('Job application not found', 404);

    const formattedData = {
      ...updateData,
      screenedAt: updateData.screenedAt ? new Date(updateData.screenedAt) : undefined,
      interviewedAt: updateData.interviewedAt ? new Date(updateData.interviewedAt) : undefined,
    };

    const application = await prisma.jobApplication.update({
      where: { id },
      data: formattedData,
      include: {
        jobPosting: {
          select: { id: true, title: true },
        },
      },
    });

    await createAuditLog(req.user.id, 'UPDATE', 'job_applications', id, existingApplication, application, req);

    res.json({
      success: true,
      message: 'Job application updated successfully',
      data: { application },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /:id - Delete application (HR/Admin only)
router.delete('/:id', authenticate, authorize('ADMIN', 'HR'), async (req, res, next) => {
  try {
    const { id } = req.params;

    const existingApplication = await prisma.jobApplication.findUnique({
      where: { id },
      include: {
        interviews: true,
      },
    });

    if (!existingApplication) throw new AppError('Job application not found', 404);

    // Delete related interviews first
    if (existingApplication.interviews.length > 0) {
      await prisma.interview.deleteMany({
        where: { applicationId: id },
      });
    }

    await prisma.jobApplication.delete({ where: { id } });

    await createAuditLog(req.user.id, 'DELETE', 'job_applications', id, existingApplication, null, req);

    res.json({
      success: true,
      message: 'Job application deleted successfully',
    });
  } catch (error) {
    next(error);
  }
});

export default router;
