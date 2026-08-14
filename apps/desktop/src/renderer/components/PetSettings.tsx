import type { PetActivityState, PetStatus } from "@kestrel/shared-types";
export function FloatingPet({ status, activity, onOpen, onPopOut }: { status: PetStatus | null; activity: PetActivityState; onOpen(): void; onPopOut(): void; }) { return null; }
export function PetSettings({ status, onChange }: { status: PetStatus | null; onChange(status: PetStatus): void }) { return null; }
