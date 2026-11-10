CREATE TABLE "project_follows" (
	"person_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_follows_person_id_project_id_pk" PRIMARY KEY("person_id","project_id")
);
--> statement-breakpoint
ALTER TABLE "project_follows" ADD CONSTRAINT "project_follows_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_follows" ADD CONSTRAINT "project_follows_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_follows_project" ON "project_follows" USING btree ("project_id");