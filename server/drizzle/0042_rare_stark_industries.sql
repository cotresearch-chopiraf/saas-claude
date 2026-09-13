CREATE INDEX "boq_items_revision_idx" ON "boq_items" USING btree ("boq_revision_id");--> statement-breakpoint
CREATE INDEX "commitment_lines_commitment_idx" ON "commitment_lines" USING btree ("commitment_id");--> statement-breakpoint
CREATE INDEX "forecast_snapshots_project_idx" ON "forecast_snapshots" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "ipc_lines_ipc_idx" ON "ipc_lines" USING btree ("ipc_id");--> statement-breakpoint
CREATE INDEX "ipc_lines_boq_item_idx" ON "ipc_lines" USING btree ("boq_item_id");--> statement-breakpoint
CREATE INDEX "measurement_lines_measurement_idx" ON "measurement_lines" USING btree ("measurement_id");--> statement-breakpoint
CREATE INDEX "measurement_lines_boq_item_idx" ON "measurement_lines" USING btree ("boq_item_id");