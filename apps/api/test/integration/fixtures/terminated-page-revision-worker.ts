import '../setup';
import { PrismaService } from '../../../src/database/prisma.service';
import { CreditsService } from '../../../src/credits/credits.service';
import { BookPageImageRevisionService } from '../../../src/books/book-page-image-revision.service';
import { PageImageRevisionExecutionGateway } from '../../../src/books/page-image-revision-execution.gateway';
import { LocalImageAssetStorage } from '../../../src/images/image-asset-storage';
import { LocalPdfStorage } from '../../../src/pdf/pdf-storage';
import { MockImageGenerationProvider } from '../../../src/images/image-generation-provider';

async function main() {
  const revisionId = process.argv[2]!;
  const db = new PrismaService();
  const storage = new LocalImageAssetStorage();
  const save = storage.saveImageAsset.bind(storage);
  storage.saveImageAsset = async (...args) => {
    const result = await save(...args);
    if (args[0].includes(`/runs/${revisionId}/`)) process.exit(86);
    return result;
  };
  const service = new BookPageImageRevisionService(
    {} as never,
    db,
    new PageImageRevisionExecutionGateway(db),
    new CreditsService(db),
    new MockImageGenerationProvider(),
    storage,
    new LocalPdfStorage(),
    { get: () => 'home' } as never,
  );
  const claimed = await service.claim(revisionId, 'terminated-page-delivery');
  if (!claimed) throw new Error('Page revision was not claimable');
  await service.executeClaimed(claimed.id, claimed.fencingVersion);
  throw new Error('Worker did not reach the image-storage termination boundary');
}

void main().catch(() => process.exit(1));
