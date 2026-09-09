import { apiFetch } from "./client";
import type { Employee, EmployeeStatus } from "./types";

// Thin typed wrappers over the existing, verified Employee API
// (server/src/routes/employees.ts) — no calculation, no authorization
// logic. Company-wide (not project-scoped). No delete endpoint exists.

export function listEmployees(): Promise<Employee[]> {
  return apiFetch<Employee[]>("/employees");
}

export function getEmployee(id: string): Promise<Employee> {
  return apiFetch<Employee>(`/employees/${id}`);
}

export interface CreateEmployeeInput {
  name: string;
  employeeNumber: string;
  jobTitle?: string;
  hireDate?: string;
  email?: string;
  phone?: string;
}

export function createEmployee(input: CreateEmployeeInput): Promise<Employee> {
  return apiFetch<Employee>("/employees", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface UpdateEmployeeInput {
  name?: string;
  employeeNumber?: string;
  jobTitle?: string;
  hireDate?: string;
  email?: string;
  phone?: string;
  status?: EmployeeStatus;
}

export function updateEmployee(id: string, input: UpdateEmployeeInput): Promise<Employee> {
  return apiFetch<Employee>(`/employees/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
