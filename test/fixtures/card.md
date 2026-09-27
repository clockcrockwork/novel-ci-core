# 架空の設計カード（synthetic fixture）

## 9. ゲート定義（機械可読）

```yaml
version: 1
pov: 青木
required_lines:
  - id: RL-01
    text: 灯台の鍵を持ってきた
    match: fuzzy
  - id: RL-02
    text: 明日も晴れる
    match: fuzzy
forbidden:
  - text: 宝くじ
    note: scope外
```
