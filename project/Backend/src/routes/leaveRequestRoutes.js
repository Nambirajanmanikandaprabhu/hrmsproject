import express from 'express';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';
import { z } from 'zod';
import { leaveRequestService } from '../services/leaveRequestService.js';

const router = express.Router();

// Validation schemas
const leaveRequestSchemas = {
  create: z.object({
    body: z.object({
      policyId: z.string().uuid(),
      startDate: z.string().datetime(),
      endDate: z.string().datetime(),
      reason: z.string().min(1),
      attachments: z.array(z.string()).optional(),
    }),
  }),
  update: z.object({
    params: z.object({ id: z.string().uuid('Invalid leave request ID') }),
    body: z.object({
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
      rejectionReason: z.string().optional(),
      cancellationReason: z.string().optional(),
    }),
  }),
  getAll: z.object({
    query: z.object({
      page: z.string().regex(/^\d+$/).optional().default('1'),
      limit: z.string().regex(/^\d+$/).optional().default('10'),
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
      employeeId: z.string().uuid().optional(),
    }),
  }),
};

// Get all leave requests
router.get('/', authenticate, authorize('ADMIN', 'HR', 'MANAGER'), validate(leaveRequestSchemas.getAll), async (req, res, next) => {
  try {
    const { page, limit, status, employeeId } = req.validatedData.query;
    const leaveRequests = await leaveRequestService.getAllLeaveRequests({ page, limit, status, employeeId, user: req.user });
    await createAuditLog(req.user.id, 'READ', 'leave_requests', null, null, null, req);
    res.json({ success: true, message: 'Leave requests fetched successfully', data: leaveRequests });
  } catch (error) {
    next(error);
  }
});

// Get single leave request
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const leaveRequest = await leaveRequestService.getLeaveRequest(id, req.user);
    await createAuditLog(req.user.id, 'READ', 'leave_requests', id, null, null, req);
    res.json({ success: true, message: 'Leave request fetched successfully', data: { leaveRequest } });
  } catch (error) {
    next(error);
  }
});

// Create leave request
router.post('/', authenticate, validate(leaveRequestSchemas.create), async (req, res, next) => {
  try {
    const leaveRequest = await leaveRequestService.createLeaveRequest({ ...req.validatedData.body, employeeId: req.user.employeeId }, req);
    res.status(201).json({ success: true, message: 'Leave request created successfully', data: { leaveRequest } });
  } catch (error) {
    next(error);
  }
});

// Update leave request (e.g., approve/reject)
router.put('/:id', authenticate, authorize('ADMIN', 'HR', 'MANAGER'), validate(leaveRequestSchemas.update), async (req, res, next) => {
  try {
    const { id } = req.params;
    const leaveRequest = await leaveRequestService.updateLeaveRequest(id, { ...req.validatedData.body, approvedById: req.user.employeeId }, req);
    res.json({ success: true, message: 'Leave request updated successfully', data: { leaveRequest } });
  } catch (error) {
    next(error);
  }
});

// Delete leave request
router.delete('/:id', authenticate, authorize('ADMIN', 'HR'), async (req, res, next) => {
  try {
    const { id } = req.params;
    await leaveRequestService.deleteLeaveRequest(id, req);
    res.json({ success: true, message: 'Leave request deleted successfully' });
  } catch (error) {
    next(error);
  }
});

export default router;