type DragTypesLike = ArrayLike<string> & {
  contains?: (type: string) => boolean;
  includes?: (type: string) => boolean;
};

export interface DragDataTransferLike {
  types?: DragTypesLike | null;
  files?: { length: number } | null;
}

const FILES_DATA_TRANSFER_TYPE = 'Files';

export function isFileDrag(dataTransfer: DragDataTransferLike | null | undefined): boolean {
  if (!dataTransfer) return false;

  const types = dataTransfer.types;
  if (types) {
    if (typeof types.contains === 'function' && types.contains(FILES_DATA_TRANSFER_TYPE)) {
      return true;
    }
    if (typeof types.includes === 'function' && types.includes(FILES_DATA_TRANSFER_TYPE)) {
      return true;
    }
    for (let i = 0; i < types.length; i++) {
      if (types[i] === FILES_DATA_TRANSFER_TYPE) return true;
    }
  }

  return (dataTransfer.files?.length ?? 0) > 0;
}
