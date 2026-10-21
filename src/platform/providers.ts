/**
 * ProvidersFacade — the platform's provider surface: a thin, honest wrapper
 * over ProviderService + ModelService + AiGateway. Delegation only.
 *
 * `currentSelection()` delegates to AiGateway.currentSelection(), which is
 * ALREADY the single selection computation — it is not reimplemented or
 * moved here.
 */
import type { AiGateway, GatewaySelection } from "../ai/gateway";
import type { ModelService, ProviderService } from "../ai/provider_service";

export interface ProvidersHandles {
  providers: ProviderService;
  models: ModelService;
  gateway: AiGateway;
}

export class ProvidersFacade {
  readonly providers: ProviderService;
  readonly models: ModelService;
  readonly gateway: AiGateway;

  constructor(handles: ProvidersHandles) {
    this.providers = handles.providers;
    this.models = handles.models;
    this.gateway = handles.gateway;
  }

  /** The underlying AiGateway handle. */
  get handle(): AiGateway {
    return this.gateway;
  }

  currentSelection(): GatewaySelection | undefined {
    return this.gateway.currentSelection();
  }
}
