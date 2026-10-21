/**
 * AdminFacade — the platform's admin surface: a thin, honest wrapper over
 * the panel controllers and the admin boundary. Delegation only.
 */
import type { AdminBoundary } from "../auth/admin_boundary";
import type { UserPanelController } from "../auth/user_controller";
import type { AiAdminController } from "../groups/ai_controller";
import type { PanelController } from "../groups/controller";

export interface AdminHandles {
  panel: PanelController;
  userPanel: UserPanelController;
  aiAdmin: AiAdminController;
  boundary?: AdminBoundary;
}

export class AdminFacade {
  readonly panel: PanelController;
  readonly userPanel: UserPanelController;
  readonly aiAdmin: AiAdminController;
  readonly boundary: AdminBoundary | undefined;

  constructor(handles: AdminHandles) {
    this.panel = handles.panel;
    this.userPanel = handles.userPanel;
    this.aiAdmin = handles.aiAdmin;
    this.boundary = handles.boundary;
  }

  get panelHandle(): PanelController {
    return this.panel;
  }

  get userPanelHandle(): UserPanelController {
    return this.userPanel;
  }

  get aiAdminHandle(): AiAdminController {
    return this.aiAdmin;
  }
}
