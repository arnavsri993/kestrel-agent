import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { retainStoreUpdateFixture, storeFixturePendingName } from './native-store-update-profile.mjs';

// The caller must finish all cleanup and disposition changes first. The seal
// callback establishes the synchronous cancellation boundary before any I/O.
export async function finalizeStoreUpdateFixture({receipt, profile, receiptPath, checkpointPath, storageEvidence, root, checkCancellation, seal}) {
 assert(!receipt.failed && !receipt.cancelled && !receipt.cleanupUnconfirmed && receipt.exactCandidateAbsent === true,
  'Cannot publish a failed, cancelled, or unconfirmed fixture.');
 assert(receipt.cleanup && !receipt.cleanup.forced && !receipt.cleanup.cleanupUnconfirmed && !receipt.cleanup.spawnError,
  'Cannot publish without clean terminal cleanup.');
 assert(receipt.generatedProfilesRemoved === false && receipt.retainedProfile === profile,
  'The retained profile disposition must be final before publication.');
 checkCancellation();
 const pending = join(dirname(checkpointPath), storeFixturePendingName);
 writeFileSync(pending, 'Store fixture finalization pending.\n', {mode:0o600, flag:'wx'});
 checkCancellation();
 seal();
 writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), {mode:0o600});
 const checkpoint = await retainStoreUpdateFixture({profile,receiptPath,checkpointPath,storageEvidence,root});
 unlinkSync(pending);
 return checkpoint;
}
