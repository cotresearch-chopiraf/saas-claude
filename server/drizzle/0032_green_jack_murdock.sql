CREATE UNIQUE INDEX "boq_revisions_contract_revision_unique" ON "boq_revisions" USING btree ("contract_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_revisions_project_revision_unique" ON "budget_revisions" USING btree ("project_id","revision_number");--> statement-breakpoint
CREATE UNIQUE INDEX "commitments_company_number_unique" ON "commitments" USING btree ("company_id","commitment_number");--> statement-breakpoint
CREATE UNIQUE INDEX "ipcs_contract_number_unique" ON "ipcs" USING btree ("contract_id","ipc_number");--> statement-breakpoint
CREATE UNIQUE INDEX "subcontract_ipcs_commitment_number_unique" ON "subcontract_ipcs" USING btree ("commitment_id","ipc_number");