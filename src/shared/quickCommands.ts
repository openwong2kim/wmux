export interface QuickCommand { id: string; title: string; text: string }
export interface QuickCommandSnapshot { revision: string; commands: QuickCommand[] }
