import { Module } from '@nestjs/common';
import { ChildPhotoProcessor } from '../images/child-photo-processor';
import { createImageAssetStorage, IMAGE_ASSET_STORAGE_TOKEN } from '../images/image-asset-storage';
import { createPdfStorage, PDF_STORAGE_TOKEN } from '../pdf/pdf-storage';

/** Owns artifact-driver construction. Feature and generation modules consume
 * only the storage interfaces/tokens exported here. */
@Module({
  providers: [
    {
      provide: PDF_STORAGE_TOKEN,
      useFactory: () => createPdfStorage(process.env['PDF_STORAGE_DRIVER']),
    },
    {
      provide: IMAGE_ASSET_STORAGE_TOKEN,
      useFactory: () => createImageAssetStorage(process.env['IMAGE_STORAGE_DRIVER']),
    },
    ChildPhotoProcessor,
  ],
  exports: [PDF_STORAGE_TOKEN, IMAGE_ASSET_STORAGE_TOKEN, ChildPhotoProcessor],
})
export class ArtifactStorageModule {}
