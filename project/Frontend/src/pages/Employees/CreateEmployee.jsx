import { useState, useCallback, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery } from 'react-query';
import { ArrowLeftIcon, UserPlusIcon } from '@heroicons/react/24/outline';
import { employeeAPI, departmentAPI } from '../../services/api';
import LoadingSpinner from '../../components/UI/LoadingSpinner';
import Alert from '../../components/UI/Alert';
import FormField from '../../components/Forms/FormField';
import { EMPLOYMENT_TYPES, EMPLOYMENT_STATUS, GENDER_OPTIONS, MARITAL_STATUS } from '../../utils/constants';
import { cn } from '../../utils/cn';
import { format } from 'date-fns';
import toast from 'react-hot-toast';

const CreateEmployee = () => {
  // Hooks for state and navigation
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState(1);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form management
  const {
    control,
    register,
    handleSubmit,
    formState: { errors },
    watch,
    trigger,
    getValues
  } = useForm({
    defaultValues: {
      employmentType: 'FULL_TIME',
      employmentStatus: 'ACTIVE',
      currency: 'USD',
    }
  });

  // Watch form values for validation
  const watchedValues = watch();

  // Fetch departments for dropdown
  const { data: departmentsData, isLoading: departmentsLoading } = useQuery(
    'departments',
    () => departmentAPI.getAll({ limit: 100, isActive: true }),
    {
      staleTime: 10 * 60 * 1000, // 10 minutes
    }
  );

  // Create employee mutation
  const createEmployeeMutation = useMutation(
    (data) => employeeAPI.create(data),
    {
      onSuccess: () => {
        toast.success('Employee created successfully!');
        navigate('/employees');
      },
      onError: (error) => {
        toast.error(error.response?.data?.message || 'Failed to create employee');
        setIsSubmitting(false);
      }
    }
  );

  // Memoized options
  const departments = useMemo(() => 
    departmentsData?.data?.departments?.filter(dept => dept.isActive) || [], 
    [departmentsData]
  );

  const employmentTypeOptions = useMemo(() => 
    Object.entries(EMPLOYMENT_TYPES).map(([key, value]) => ({
      value,
      label: key.replace('_', ' ')
    })), 
    []
  );

  const employmentStatusOptions = useMemo(() => 
    Object.entries(EMPLOYMENT_STATUS).map(([key, value]) => ({
      value,
      label: key.replace('_', ' ')
    })), 
    []
  );

  const genderOptions = useMemo(() => 
    Object.entries(GENDER_OPTIONS).map(([key, value]) => ({
      value,
      label: key
    })), 
    []
  );

  const maritalStatusOptions = useMemo(() => 
    Object.entries(MARITAL_STATUS).map(([key, value]) => ({
      value,
      label: key
    })), 
    []
  );

  // Form steps configuration
  const steps = useMemo(() => [
    {
      id: 1,
      title: 'Basic Information',
      description: 'Personal details and contact information',
      fields: ['employeeId', 'firstName', 'lastName', 'email', 'phone']
    },
    {
      id: 2,
      title: 'Personal Details',
      description: 'Additional personal information',
      fields: ['middleName', 'dateOfBirth', 'gender', 'maritalStatus', 'nationality']
    },
    {
      id: 3,
      title: 'Employment Information',
      description: 'Job details and organizational structure',
      fields: ['departmentId', 'positionId', 'managerId', 'employmentType', 'hireDate', 'baseSalary']
    },
    {
      id: 4,
      title: 'Address & Emergency Contact',
      description: 'Address and emergency contact details',
      fields: ['address', 'city', 'state', 'country', 'zipCode', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation']
    }
  ], []);

  // Event handlers
  const handleNextStep = useCallback(async () => {
    const currentStepFields = steps[currentStep - 1].fields;
    const isValid = await trigger(currentStepFields);
    
    if (isValid) {
      setCurrentStep(prev => Math.min(prev + 1, steps.length));
    }
  }, [currentStep, steps, trigger]);

  const handlePrevStep = useCallback(() => {
    setCurrentStep(prev => Math.max(prev - 1, 1));
  }, []);

  const onSubmit = useCallback(async (data) => {
    setIsSubmitting(true);
    try {
      // Format the data
      const formattedData = {
        ...data,
        hireDate: new Date(data.hireDate).toISOString(),
        dateOfBirth: data.dateOfBirth ? new Date(data.dateOfBirth).toISOString() : undefined,
        baseSalary: data.baseSalary ? parseFloat(data.baseSalary) : undefined,
        // Remove empty strings
        ...Object.fromEntries(
          Object.entries(data).filter(([_, value]) => value !== '')
        )
      };
      
      await createEmployeeMutation.mutateAsync(formattedData);
    } catch (error) {
      // Error handling is done in mutation
    }
  }, [createEmployeeMutation]);

  // Render step indicator
  const renderStepIndicator = () => (
    <div className="mb-8">
      <nav aria-label="Progress">
        <ol className="flex items-center">
          {steps.map((step, stepIdx) => (
            <li key={step.id} className={cn(
              stepIdx !== steps.length - 1 ? 'pr-8 sm:pr-20' : '',
              'relative'
            )}>
              {stepIdx !== steps.length - 1 && (
                <div className="absolute inset-0 flex items-center" aria-hidden="true">
                  <div className={cn(
                    'h-0.5 w-full',
                    currentStep > step.id ? 'bg-indigo-600' : 'bg-gray-200'
                  )} />
                </div>
              )}
              <div className={cn(
                'relative w-8 h-8 flex items-center justify-center rounded-full border-2',
                currentStep > step.id
                  ? 'bg-indigo-600 border-indigo-600'
                  : currentStep === step.id
                  ? 'border-indigo-600 bg-white'
                  : 'border-gray-300 bg-white'
              )}>
                <span className={cn(
                  'text-sm font-medium',
                  currentStep > step.id
                    ? 'text-white'
                    : currentStep === step.id
                    ? 'text-indigo-600'
                    : 'text-gray-500'
                )}>
                  {step.id}
                </span>
              </div>
              <div className="mt-2">
                <div className={cn(
                  'text-sm font-medium',
                  currentStep >= step.id ? 'text-indigo-600' : 'text-gray-500'
                )}>
                  {step.title}
                </div>
                <div className="text-xs text-gray-500">{step.description}</div>
              </div>
            </li>
          ))}
        </ol>
      </nav>
    </div>
  );

  // Render form step content
  const renderStepContent = () => {
    switch (currentStep) {
      case 1:
        return (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <FormField
                name="employeeId"
                control={control}
                label="Employee ID"
                placeholder="EMP001"
                required
                rules={{ required: 'Employee ID is required' }}
              />
              <FormField
                name="email"
                control={control}
                type="email"
                label="Email Address"
                placeholder="john.doe@company.com"
                required
                rules={{
                  required: 'Email is required',
                  pattern: {
                    value: /^\S+@\S+$/i,
                    message: 'Invalid email address',
                  },
                }}
              />
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
              <FormField
                name="firstName"
                control={control}
                label="First Name"
                placeholder="John"
                required
                rules={{ required: 'First name is required' }}
              />
              <FormField
                name="middleName"
                control={control}
                label="Middle Name"
                placeholder="Optional"
              />
              <FormField
                name="lastName"
                control={control}
                label="Last Name"
                placeholder="Doe"
                required
                rules={{ required: 'Last name is required' }}
              />
            </div>
            <FormField
              name="phone"
              control={control}
              type="tel"
              label="Phone Number"
              placeholder="+1 (555) 123-4567"
              helperText="Include country code for international numbers"
            />
          </div>
        );

      case 2:
        return (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <FormField
                name="dateOfBirth"
                control={control}
                type="date"
                label="Date of Birth"
              />
              <FormField
                name="gender"
                control={control}
                type="select"
                label="Gender"
                placeholder="Select Gender"
                options={genderOptions}
              />
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <FormField
                name="maritalStatus"
                control={control}
                type="select"
                label="Marital Status"
                placeholder="Select Status"
                options={maritalStatusOptions}
              />
              <FormField
                name="nationality"
                control={control}
                label="Nationality"
                placeholder="American"
              />
            </div>
          </div>
        );

      case 3:
        return (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <FormField
                name="departmentId"
                control={control}
                type="select"
                label="Department"
                placeholder="Select Department"
                options={departments.map(dept => ({
                  value: dept.id,
                  label: dept.name
                }))}
                disabled={departmentsLoading}
              />
              <FormField
                name="employmentType"
                control={control}
                type="select"
                label="Employment Type"
                required
                options={employmentTypeOptions}
                rules={{ required: 'Employment type is required' }}
              />
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <FormField
                name="hireDate"
                control={control}
                type="date"
                label="Hire Date"
                required
                rules={{ required: 'Hire date is required' }}
              />
              <FormField
                name="baseSalary"
                control={control}
                type="number"
                label="Base Salary"
                placeholder="50000.00"
                helperText="Annual base salary amount"
              />
            </div>
            <FormField
              name="employmentStatus"
              control={control}
              type="select"
              label="Employment Status"
              options={employmentStatusOptions}
            />
          </div>
        );

      case 4:
        return (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">Address Information</h3>
              <div className="space-y-4">
                <FormField
                  name="address"
                  control={control}
                  type="textarea"
                  label="Street Address"
                  placeholder="123 Main Street, Apt 4B"
                  rows={2}
                />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField
                    name="city"
                    control={control}
                    label="City"
                    placeholder="New York"
                  />
                  <FormField
                    name="state"
                    control={control}
                    label="State/Province"
                    placeholder="NY"
                  />
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField
                    name="country"
                    control={control}
                    label="Country"
                    placeholder="United States"
                  />
                  <FormField
                    name="zipCode"
                    control={control}
                    label="ZIP/Postal Code"
                    placeholder="10001"
                  />
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-lg font-medium text-gray-900 mb-4">Emergency Contact</h3>
              <div className="space-y-4">
                <FormField
                  name="emergencyContactName"
                  control={control}
                  label="Contact Name"
                  placeholder="Jane Doe"
                />
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <FormField
                    name="emergencyContactPhone"
                    control={control}
                    type="tel"
                    label="Contact Phone"
                    placeholder="+1 (555) 987-6543"
                  />
                  <FormField
                    name="emergencyContactRelation"
                    control={control}
                    label="Relationship"
                    placeholder="Spouse, Parent, Sibling, etc."
                  />
                </div>
              </div>
            </div>
          </div>
        );

      default:
        return null;
    }
  };

  // Render navigation buttons
  const renderNavigationButtons = () => (
    <div className="flex justify-between pt-6 border-t border-gray-200">
      <div>
        {currentStep > 1 && (
          <button
            type="button"
            onClick={handlePrevStep}
            className="btn-outline"
          >
            Previous
          </button>
        )}
      </div>
      <div className="flex space-x-3">
        <Link to="/employees" className="btn-outline">
          Cancel
        </Link>
        {currentStep < steps.length ? (
          <button
            type="button"
            onClick={handleNextStep}
            className="btn-primary"
          >
            Next
          </button>
        ) : (
          <button
            type="submit"
            disabled={isSubmitting}
            className="btn-primary flex items-center"
          >
            {isSubmitting ? (
              <>
                <LoadingSpinner size="sm" className="mr-2" />
                Creating...
              </>
            ) : (
              <>
                <UserPlusIcon className="h-5 w-5 mr-2" />
                Create Employee
              </>
            )}
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center space-x-4">
        <Link 
          to="/employees" 
          className="btn-outline hover:shadow-md transition-all duration-200"
        >
          <ArrowLeftIcon className="h-5 w-5 mr-2" />
          Back
        </Link>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Add New Employee</h1>
          <p className="text-sm text-gray-500">Create a new employee record</p>
        </div>
      </div>

      {/* Progress Indicator */}
      {renderStepIndicator()}

      {/* Form */}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <div className="card">
          <div className="card-header">
            <h3 className="text-lg font-medium text-gray-900">
              {steps[currentStep - 1]?.title}
            </h3>
            <p className="text-sm text-gray-500">
              {steps[currentStep - 1]?.description}
            </p>
          </div>
          <div className="card-content">
            {renderStepContent()}
          </div>
          {renderNavigationButtons()}
        </div>
      </form>

      {/* Form Summary (Last Step) */}
      {currentStep === steps.length && (
        <div className="card">
          <div className="card-header">
            <h3 className="text-lg font-medium text-gray-900">Review Information</h3>
            <p className="text-sm text-gray-500">
              Please review the information before creating the employee record
            </p>
          </div>
          <div className="card-content">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <div>
                <h4 className="font-medium text-gray-900 mb-3">Basic Information</h4>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Name:</dt>
                    <dd className="text-gray-900">
                      {watchedValues.firstName} {watchedValues.middleName} {watchedValues.lastName}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Employee ID:</dt>
                    <dd className="text-gray-900">{watchedValues.employeeId}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Email:</dt>
                    <dd className="text-gray-900">{watchedValues.email}</dd>
                  </div>
                  {watchedValues.phone && (
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Phone:</dt>
                      <dd className="text-gray-900">{watchedValues.phone}</dd>
                    </div>
                  )}
                </dl>
              </div>
              <div>
                <h4 className="font-medium text-gray-900 mb-3">Employment Details</h4>
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Department:</dt>
                    <dd className="text-gray-900">
                      {departments.find(d => d.id === watchedValues.departmentId)?.name || 'N/A'}
                    </dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Employment Type:</dt>
                    <dd className="text-gray-900">{watchedValues.employmentType?.replace('_', ' ')}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt className="text-gray-500">Hire Date:</dt>
                    <dd className="text-gray-900">
                      {watchedValues.hireDate ? format(new Date(watchedValues.hireDate), 'MMM dd, yyyy') : 'N/A'}
                    </dd>
                  </div>
                  {watchedValues.baseSalary && (
                    <div className="flex justify-between">
                      <dt className="text-gray-500">Base Salary:</dt>
                      <dd className="text-gray-900">
                        {watchedValues.currency} {parseFloat(watchedValues.baseSalary).toLocaleString()}
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Error Display */}
      {Object.keys(errors).length > 0 && (
        <Alert variant="error" title="Please fix the following errors:">
          <ul className="list-disc list-inside space-y-1">
            {Object.entries(errors).map(([field, error]) => (
              <li key={field} className="text-sm">
                {error.message}
              </li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
};

export default CreateEmployee;