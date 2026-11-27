/** 可配置字段注册项（代码声明；用户只改 options）。无 Node 依赖，可供前端引用。 */
export type FieldDef = {
  key: string; // `${AssetType}.${fieldKey}`
  assetType: string;
  fieldKey: string;
  typeLabel: string;
  fieldLabel: string;
  kind: 'enum';
  defaultOptions: string[];
  allowCustom: boolean;
  /** 列表「类型」旁显示该字段当前值 */
  listBesideType?: boolean;
};

/** 第一期：仅平台账号 · 平台/网站 */
export const FIELD_DEFS: FieldDef[] = [
  {
    key: 'login_account.provider',
    assetType: 'login_account',
    fieldKey: 'provider',
    typeLabel: '平台账号',
    fieldLabel: '平台/网站',
    kind: 'enum',
    defaultOptions: ['阿里云', '腾讯云', '华为云', 'GitHub'],
    allowCustom: true,
    listBesideType: true,
  },
];
