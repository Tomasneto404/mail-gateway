-- Settings edited from the admin UI (singleton row id = 1, created on first save).
CREATE TABLE "gateway_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "sandbox_ui_url" TEXT,
    "sandbox_api_url" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "gateway_settings_pkey" PRIMARY KEY ("id")
);
