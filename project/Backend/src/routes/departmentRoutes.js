// src/routes/departmentRoutes.js
import express from 'express';
import { z } from 'zod';
import { authenticate, authorize } from '../middleware/auth.js';
import { validate } from '../middleware/validation.js';
import prisma from '../config/prisma.js';
import { AppError, ValidationError } from '../utils/errors.js';
import { createAuditLog } from '../middleware/auditMiddleware.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Validation schemas
const departmentSchema = z.object({
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters'),
    managerId: z.string().uuid('Invalid manager ID').optional(),
    parentId: z.string().uuid('Invalid parent department ID').optional(),
    isActive: z.boolean().default(true),
    description: z.string().max(500, 'Description must be less than 500 characters').nullable().optional(),
  }),
});

const updateDepartmentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid department ID'),
  }),
  body: z.object({
    name: z.string().min(1, 'Name is required').max(100, 'Name must be less than 100 characters').optional(),
    managerId: z.string().uuid('Invalid manager ID').nullable().optional(),
    parentId: z.string().uuid('Invalid parent department ID').nullable().optional(),
    isActive: z.boolean().optional(),
    description: z.string().max(500, 'Description must be less than 500 characters').nullable().optional(),
  }),
});

const listDepartmentsSchema = z.object({
  query: z.object({
    page: z.preprocess((val) => {
      if (typeof val === 'string' && val.trim() !== '') {
        const num = parseInt(val, 10);
        return isNaN(num) ? 1 : num;
      }
      return 1;
    }, z.number().min(1, 'Page must be at least 1').default(1)),
    
    limit: z.preprocess((val) => {
      if (typeof val === 'string' && val.trim() !== '') {
        const num = parseInt(val, 10);
        return isNaN(num) ? 10 : Math.min(Math.max(num, 1), 100);
      }
      return 10;
    }, z.number().min(1, 'Limit must be at least 1').max(100, 'Limit cannot exceed 100').default(10)),
    
    isActive: z.preprocess((val) => {
      if (val === 'true') return true;
      if (val === 'false') return false;
      return undefined;
    }, z.boolean().optional()),
    
    parentId: z.string().uuid('Invalid parent department ID').optional().or(z.literal('')),
    
    search: z.string().min(1, 'Search term must not be empty').optional().or(z.literal('')),
    
    sortBy: z.enum(['name', 'createdAt', 'updatedAt']).default('name').catch('name'),
    
    sortOrder: z.enum(['asc', 'desc']).default('asc').catch('asc'),
  }),
});

const getDepartmentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid department ID'),
  }),
});

const deleteDepartmentSchema = z.object({
  params: z.object({
    id: z.string().uuid('Invalid department ID'),
  }),
});

/**
 * Checks for circular parent-child relationships in department hierarchy
 * @param {string} departmentId - The department ID being updated
 * @param {string} parentId - The proposed new parent ID
 * @returns {Promise<boolean>} True if circular reference is detected
 */
const checkCircularReference = async (departmentId, parentId) => {
  if (departmentId === parentId) {
    return true;
  }

  let currentParentId = parentId;
  const visitedIds = new Set([departmentId]);

  while (currentParentId) {
    if (visitedIds.has(currentParentId)) {
      return true; // Circular reference found
    }
    
    visitedIds.add(currentParentId);
    
    try {
      const parent = await prisma.department.findUnique({
        where: { id: currentParentId },
        select: { parentId: true },
      });
      
      if (!parent) break;
      currentParentId = parent.parentId;
    } catch (error) {
      logger.error('Error checking circular reference', { error: error.message });
      break;
    }
  }

  return false;
};

// GET / - List departments
router.get(
  '/',
  authenticate,
  authorize('ADMIN', 'HR', 'MANAGER'),
  validate(listDepartmentsSchema),
  async (req, res, next) => {
    try {
      const { page, limit, isActive, parentId, search, sortBy, sortOrder } = req.validatedData.query;
      
      const skip = (page - 1) * limit;

      // Build where clause
      const where = {};
      if (isActive !== undefined) where.isActive = isActive;
      if (parentId && parentId.trim() !== '') where.parentId = parentId;
      if (search && search.trim() !== '') {
        where.OR = [
          { name: { contains: search.trim(), mode: 'insensitive' } },
          { description: { contains: search.trim(), mode: 'insensitive' } },
        ];
      }

      // Build orderBy clause
      const orderBy = {};
      orderBy[sortBy] = sortOrder;

      try {
        const [departments, total] = await Promise.all([
          prisma.department.findMany({
            where,
            skip,
            take: limit,
            include: {
              manager: { 
                select: { 
                  id: true, 
                  employeeId: true,
                  firstName: true, 
                  lastName: true, 
                  email: true,
                  position: { select: { title: true } }
                } 
              },
              parent: { select: { id: true, name: true } },
              _count: { 
                select: { 
                  employees: { where: { employmentStatus: 'ACTIVE' } }, 
                  children: { where: { isActive: true } }
                } 
              },
            },
            orderBy,
          }),
          prisma.department.count({ where }),
        ]);

        await createAuditLog(req.user.id, 'READ', 'department', null, null, null, req);

        res.json({
          success: true,
          message: 'Departments fetched successfully',
          data: {
            departments,
            pagination: {
              page,
              limit,
              total,
              pages: Math.ceil(total / limit),
              hasNext: page < Math.ceil(total / limit),
              hasPrev: page > 1,
            },
          },
        });
      } catch (dbError) {
        logger.error('Database error in department listing', { 
          error: dbError.message, 
          stack: dbError.stack 
        });
        throw new AppError('Failed to fetch departments from database', 500);
      }
    } catch (error) {
      logger.error('Department listing error', { error: error.message });
      next(error);
    }
  }
);

// GET /:id - Get department details
router.get(
  '/:id', 
  authenticate, 
  authorize('ADMIN', 'HR', 'MANAGER'), 
  validate(getDepartmentSchema),
  async (req, res, next) => {
    try {
      const { id } = req.validatedData.params;

      const department = await prisma.department.findUnique({
        where: { id },
        include: {
          manager: { 
            select: { 
              id: true, 
              employeeId: true,
              firstName: true, 
              lastName: true, 
              email: true,
              position: { select: { title: true } }
            } 
          },
          parent: { select: { id: true, name: true } },
          children: { 
            where: { isActive: true },
            select: { id: true, name: true, isActive: true, _count: { select: { employees: true } } },
            orderBy: { name: 'asc' }
          },
          employees: {
            where: { employmentStatus: 'ACTIVE' },
            select: { 
              id: true, 
              employeeId: true, 
              firstName: true, 
              lastName: true, 
              email: true, 
              employmentStatus: true,
              position: { select: { title: true } },
              hireDate: true
            },
            orderBy: { firstName: 'asc' }
          },
          positions: {
            select: { 
              id: true, 
              title: true, 
              isActive: true, 
              _count: { select: { employees: { where: { employmentStatus: 'ACTIVE' } } } 
            },
            orderBy: { title: 'asc' }
          },
        },
      }});

      if (!department) {
        throw new AppError('Department not found', 404);
      }

      await createAuditLog(req.user.id, 'READ', 'department', id, null, null, req);

      res.json({ 
        success: true,
        message: 'Department details fetched successfully',
        data: { department } 
      });
    } catch (error) {
      logger.error('Get department error', { error: error.message });
      next(error);
    }
  }
);

// POST / - Create department
router.post(
  '/', 
  authenticate, 
  authorize('ADMIN', 'HR'), 
  validate(departmentSchema), 
  async (req, res, next) => {
    try {
      const { name, managerId, parentId, description, isActive } = req.validatedData.body;

      // Check if department name already exists
      const existingDepartment = await prisma.department.findFirst({ 
        where: { 
          name: {
            equals: name.trim(),
            mode: 'insensitive'
          }
        } 
      });
      if (existingDepartment) {
        throw new ValidationError('Department name already exists');
      }

      // Validate manager exists and is active
      if (managerId) {
        const manager = await prisma.employee.findFirst({
          where: { 
            id: managerId,
            employmentStatus: 'ACTIVE'
          }
        });
        if (!manager) {
          throw new ValidationError('Manager not found or not active');
        }
      }

      // Validate parent department exists and is active
      if (parentId) {
        const parent = await prisma.department.findFirst({
          where: { 
            id: parentId,
            isActive: true
          }
        });
        if (!parent) {
          throw new ValidationError('Parent department not found or not active');
        }
      }

      const department = await prisma.department.create({
        data: { 
          name: name.trim(), 
          managerId, 
          parentId, 
          description: description?.trim() || null,
          isActive: isActive ?? true
        },
        include: {
          manager: { 
            select: { 
              id: true, 
              employeeId: true,
              firstName: true, 
              lastName: true, 
              email: true,
              position: { select: { title: true } }
            } 
          },
          parent: { select: { id: true, name: true } },
        },
      });

      await createAuditLog(req.user.id, 'CREATE', 'department', department.id, null, department, req);

      res.status(201).json({
        success: true,
        message: 'Department created successfully',
        data: { department },
      });
    } catch (error) {
      logger.error('Create department error', { error: error.message });
      next(error);
    }
  }
);

// PUT /:id - Update department
router.put(
  '/:id', 
  authenticate, 
  authorize('ADMIN', 'HR'), 
  validate(updateDepartmentSchema), 
  async (req, res, next) => {
    try {
      const { id } = req.validatedData.params;
      const { name, managerId, parentId, isActive, description } = req.validatedData.body;

      const existingDepartment = await prisma.department.findUnique({ where: { id } });
      if (!existingDepartment) {
        throw new AppError('Department not found', 404);
      }

      // Check if name is being changed and if it conflicts
      if (name && name.trim() !== existingDepartment.name) {
        const nameConflict = await prisma.department.findFirst({ 
          where: { 
            name: {
              equals: name.trim(),
              mode: 'insensitive'
            },
            NOT: { id }
          } 
        });
        if (nameConflict) {
          throw new ValidationError('Department name already exists');
        }
      }

      // Validate manager exists and is active
      if (managerId) {
        const manager = await prisma.employee.findFirst({
          where: { 
            id: managerId,
            employmentStatus: 'ACTIVE'
          }
        });
        if (!manager) {
          throw new ValidationError('Manager not found or not active');
        }
      }

      // Validate parent department and check for circular references
      if (parentId !== undefined) {
        if (parentId) {
          const parent = await prisma.department.findFirst({
            where: { 
              id: parentId,
              isActive: true
            }
          });
          if (!parent) {
            throw new ValidationError('Parent department not found or not active');
          }

          // Check for circular reference
          const hasCircularRef = await checkCircularReference(id, parentId);
          if (hasCircularRef) {
            throw new ValidationError('Cannot create circular parent-child relationship');
          }
        }
      }

      // Build update data object
      const updateData = {};
      if (name !== undefined) updateData.name = name.trim();
      if (managerId !== undefined) updateData.managerId = managerId;
      if (parentId !== undefined) updateData.parentId = parentId;
      if (isActive !== undefined) updateData.isActive = isActive;
      if (description !== undefined) updateData.description = description?.trim() || null;

      const department = await prisma.department.update({
        where: { id },
        data: updateData,
        include: {
          manager: { 
            select: { 
              id: true, 
              employeeId: true,
              firstName: true, 
              lastName: true, 
              email: true,
              position: { select: { title: true } }
            } 
          },
          parent: { select: { id: true, name: true } },
        },
      });

      await createAuditLog(req.user.id, 'UPDATE', 'department', id, existingDepartment, department, req);

      res.json({ 
        success: true, 
        message: 'Department updated successfully', 
        data: { department } 
      });
    } catch (error) {
      logger.error('Update department error', { error: error.message });
      next(error);
    }
  }
);

// DELETE /:id - Soft delete department
router.delete(
  '/:id', 
  authenticate, 
  authorize('ADMIN', 'HR'), 
  validate(deleteDepartmentSchema),
  async (req, res, next) => {
    try {
      const { id } = req.validatedData.params;

      const existingDepartment = await prisma.department.findUnique({
        where: { id },
        include: {
          employees: { where: { employmentStatus: 'ACTIVE' } },
          children: { where: { isActive: true } },
          positions: { where: { isActive: true } },
        },
      });

      if (!existingDepartment) {
        throw new AppError('Department not found', 404);
      }

      if (!existingDepartment.isActive) {
        throw new ValidationError('Department is already inactive');
      }

      if (existingDepartment.employees.length > 0) {
        throw new ValidationError(
          `Cannot delete department with ${existingDepartment.employees.length} active employee(s). Please reassign employees first.`
        );
      }

      if (existingDepartment.children.length > 0) {
        throw new ValidationError(
          `Cannot delete department with ${existingDepartment.children.length} active child department(s). Please reassign or delete child departments first.`
        );
      }

      if (existingDepartment.positions.length > 0) {
        throw new ValidationError(
          `Cannot delete department with ${existingDepartment.positions.length} active position(s). Please reassign or delete positions first.`
        );
      }

      const department = await prisma.department.update({
        where: { id },
        data: { 
          isActive: false,
          // Clear manager when deactivating to avoid referential issues
          managerId: null
        },
      });

      await createAuditLog(req.user.id, 'DELETE', 'department', id, existingDepartment, department, req);

      res.json({ 
        success: true, 
        message: 'Department deleted successfully', 
        data: { department } 
      });
    } catch (error) {
      logger.error('Delete department error', { error: error.message });
      next(error);
    }
  }
);

// GET /:id/hierarchy - Get department hierarchy
router.get(
  '/:id/hierarchy',
  authenticate,
  authorize('ADMIN', 'HR', 'MANAGER'),
  validate(getDepartmentSchema),
  async (req, res, next) => {
    try {
      const { id } = req.validatedData.params;

      const department = await prisma.department.findUnique({
        where: { id },
        include: {
          parent: { select: { id: true, name: true } },
          children: {
            where: { isActive: true },
            select: { 
              id: true, 
              name: true,
              children: {
                where: { isActive: true },
                select: { id: true, name: true }
              }
            },
            orderBy: { name: 'asc' }
          }
        }
      });

      if (!department) {
        throw new AppError('Department not found', 404);
      }

      // Get full hierarchy path to root
      const hierarchyPath = [];
      let current = department;
      
      while (current) {
        hierarchyPath.unshift({
          id: current.id,
          name: current.name
        });
        
        if (current.parent) {
          current = await prisma.department.findUnique({
            where: { id: current.parent.id },
            include: { parent: { select: { id: true, name: true } } }
          });
        } else {
          current = null;
        }
      }

      await createAuditLog(req.user.id, 'READ', 'department', id, null, null, req);

      res.json({
        success: true,
        message: 'Department hierarchy fetched successfully',
        data: {
          department,
          hierarchyPath,
          children: department.children
        }
      });
    } catch (error) {
      logger.error('Get department hierarchy error', { error: error.message });
      next(error);
    }
  }
);

export default router;