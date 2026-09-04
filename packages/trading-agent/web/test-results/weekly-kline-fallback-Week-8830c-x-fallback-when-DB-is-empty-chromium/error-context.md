# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: weekly-kline-fallback.spec.ts >> Weekly Kline Fallback >> should fetch and render weekly klines from mootdx fallback when DB is empty
- Location: e2e\weekly-kline-fallback.spec.ts:4:2

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: page.click: Test timeout of 60000ms exceeded.
Call log:
  - waiting for locator('.search-dropdown-item')

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - generic [ref=e4]:
    - generic [ref=e5]:
      - generic [ref=e6]: π
      - generic [ref=e7]: Trading Agent
    - generic [ref=e8]:
      - generic [ref=e9] [cursor=pointer]:
        - generic [ref=e10]: 上证指数
        - generic [ref=e11]: "4031.34"
        - generic [ref=e12]: ▲
        - generic [ref=e13]: 0.06%
      - generic [ref=e14] [cursor=pointer]:
        - generic [ref=e15]: 深证成指
        - generic [ref=e16]: "15480.12"
        - generic [ref=e17]: ▼
        - generic [ref=e18]: "-0.12%"
      - generic [ref=e19] [cursor=pointer]:
        - generic [ref=e20]: 创业板指
        - generic [ref=e21]: "4010.82"
        - generic [ref=e22]: ▼
        - generic [ref=e23]: "-0.16%"
      - generic [ref=e24] [cursor=pointer]:
        - generic [ref=e25]: 科创50
        - generic [ref=e26]: "1978.75"
        - generic [ref=e27]: ▼
        - generic [ref=e28]: "-0.43%"
      - generic [ref=e29] [cursor=pointer]:
        - generic [ref=e30]: 沪深300
        - generic [ref=e31]: "4809.50"
        - generic [ref=e32]: ▼
        - generic [ref=e33]: "-0.06%"
      - generic [ref=e34] [cursor=pointer]:
        - generic [ref=e35]: 中证500
        - generic [ref=e36]: "8702.33"
        - generic [ref=e37]: ▲
        - generic [ref=e38]: 0.09%
  - generic [ref=e39]:
    - generic [ref=e40]: RESEARCH
    - textbox "搜索股票 (代码/名称/拼音)" [active] [ref=e42]: "001237"
  - generic [ref=e43]:
    - generic [ref=e44]:
      - generic [ref=e46]: 股票池
      - generic [ref=e47]:
        - generic [ref=e48]:
          - generic [ref=e49] [cursor=pointer]:
            - generic [ref=e50]:
              - generic [ref=e51]: "[111] 未来关注股池"
              - button "×" [ref=e52]
            - generic [ref=e53]: 5 只
          - generic [ref=e54] [cursor=pointer]:
            - generic [ref=e55]:
              - generic [ref=e56]: "[110] sw2龙头股池"
              - button "×" [ref=e57]
            - generic [ref=e58]: 269 只
          - generic [ref=e59] [cursor=pointer]:
            - generic [ref=e60]:
              - generic [ref=e61]: "[109] 能源金属_龙头_20260701"
              - button "×" [ref=e62]
            - generic [ref=e63]: 5 只
          - generic [ref=e64] [cursor=pointer]:
            - generic [ref=e65]:
              - generic [ref=e66]: "[107] 固态电池_龙头_20260701"
              - button "×" [ref=e67]
            - generic [ref=e68]: 6 只
          - generic [ref=e69] [cursor=pointer]:
            - generic [ref=e70]:
              - generic [ref=e71]: "[102] 储能_龙头_20260701"
              - button "×" [ref=e72]
            - generic [ref=e73]: 3 只
          - generic [ref=e74] [cursor=pointer]:
            - generic [ref=e75]:
              - generic [ref=e76]: "[100] 核聚变_龙头_20260701"
              - button "×" [ref=e77]
            - generic [ref=e78]: 3 只
          - generic [ref=e79] [cursor=pointer]:
            - generic [ref=e80]:
              - generic [ref=e81]: "[99] 白酒II_龙头_20260701_1782882658378"
              - button "×" [ref=e82]
            - generic [ref=e83]: 2 只
          - generic [ref=e84] [cursor=pointer]:
            - generic [ref=e85]:
              - generic [ref=e86]: "[98] test-debug"
              - button "×" [ref=e87]
            - generic [ref=e88]: 2 只
          - generic [ref=e89] [cursor=pointer]:
            - generic [ref=e90]:
              - generic [ref=e91]: "[97] 白酒II_龙头_20260701"
              - button "×" [ref=e92]
            - generic [ref=e93]: 0 只
          - generic [ref=e94] [cursor=pointer]:
            - generic [ref=e95]:
              - generic [ref=e96]: "[96] sw_l2趋势百强"
              - button "×" [ref=e97]
            - generic [ref=e98]: 0 只
          - generic [ref=e99] [cursor=pointer]:
            - generic [ref=e100]:
              - generic [ref=e101]: "[95] MA多头排列行业成分股"
              - button "×" [ref=e102]
            - generic [ref=e103]: 0 只
          - generic [ref=e104] [cursor=pointer]:
            - generic [ref=e105]:
              - generic [ref=e106]: "[94] sw_l2多头排列行业成分股"
              - button "×" [ref=e107]
            - generic [ref=e108]: 0 只
          - generic [ref=e109] [cursor=pointer]:
            - generic [ref=e110]:
              - generic [ref=e111]: "[85] 沪深300"
              - button "×" [ref=e112]
            - generic [ref=e113]: 300 只
          - generic [ref=e114] [cursor=pointer]:
            - generic [ref=e115]:
              - generic [ref=e116]: "[84] 中证2000"
              - button "×" [ref=e117]
            - generic [ref=e118]: 2000 只
          - generic [ref=e119] [cursor=pointer]:
            - generic [ref=e120]:
              - generic [ref=e121]: "[82] 中证1000"
              - button "×" [ref=e122]
            - generic [ref=e123]: 1000 只
          - generic [ref=e124] [cursor=pointer]:
            - generic [ref=e125]:
              - generic [ref=e126]: "[81] 中证500"
              - button "×" [ref=e127]
            - generic [ref=e128]: 500 只
          - generic [ref=e129] [cursor=pointer]:
            - generic [ref=e130]:
              - generic [ref=e131]: "[77] 自选股_supertrend_最终持仓_2026-06-26"
              - button "×" [ref=e132]
            - generic [ref=e133]: 101 只
          - generic [ref=e134] [cursor=pointer]:
            - generic [ref=e135]:
              - generic [ref=e136]: "[76] 自选股_supertrend_最终持仓_2026-05-27"
              - button "×" [ref=e137]
            - generic [ref=e138]: 127 只
          - generic [ref=e139] [cursor=pointer]:
            - generic [ref=e140]:
              - generic [ref=e141]: "[75] 自选股_ma_cross_最终持仓_2026-05-27"
              - button "×" [ref=e142]
            - generic [ref=e143]: 96 只
          - generic [ref=e144] [cursor=pointer]:
            - generic [ref=e145]:
              - generic [ref=e146]: "[74] 最近访问_supertrend_最终持仓_2026-06-15"
              - button "×" [ref=e147]
            - generic [ref=e148]: 42 只
          - generic [ref=e149] [cursor=pointer]:
            - generic [ref=e150]:
              - generic [ref=e151]: "[73] 沪深300_macd_cross_最终持仓_2026-06-15"
              - button "×" [ref=e152]
            - generic [ref=e153]: 105 只
          - generic [ref=e154] [cursor=pointer]:
            - generic [ref=e155]:
              - generic [ref=e156]: "[72] 沪深300_ma_cross_最终持仓_2026-06-15"
              - button "×" [ref=e157]
            - generic [ref=e158]: 63 只
          - generic [ref=e159] [cursor=pointer]:
            - generic [ref=e160]:
              - generic [ref=e161]: "[71] 沪深300_supertrend_最终持仓_2026-06-15"
              - button "×" [ref=e162]
            - generic [ref=e163]: 71 只
          - generic [ref=e164] [cursor=pointer]:
            - generic [ref=e165]:
              - generic [ref=e166]: "[70] 自选股_supertrend_最终持仓_2026-06-12"
              - button "×" [ref=e167]
            - generic [ref=e168]: 62 只
          - generic [ref=e169] [cursor=pointer]:
            - generic [ref=e170]:
              - generic [ref=e171]: "[67] 53号股池_ma_cross_最终持仓_2026-06-12"
              - button "×" [ref=e172]
            - generic [ref=e173]: 74 只
          - generic [ref=e174] [cursor=pointer]:
            - generic [ref=e175]:
              - generic [ref=e176]: "[66] 53号股池_supertrend_最终持仓_2026-06-12"
              - button "×" [ref=e177]
            - generic [ref=e178]: 56 只
          - generic [ref=e179] [cursor=pointer]:
            - generic [ref=e180]:
              - generic [ref=e181]: "[63] 53号股池_MA金叉持仓_20260611"
              - button "×" [ref=e182]
            - generic [ref=e183]: 9 只
          - generic [ref=e184] [cursor=pointer]:
            - generic [ref=e185]:
              - generic [ref=e186]: "[62] 最近访问"
              - button "×" [ref=e187]
            - generic [ref=e188]: 147 只
          - generic [ref=e189] [cursor=pointer]:
            - generic [ref=e190]:
              - generic [ref=e191]: "[61] 53号股池_Alpha5D_Top20"
              - button "×" [ref=e192]
            - generic [ref=e193]: 20 只
          - generic [ref=e194] [cursor=pointer]:
            - generic [ref=e195]:
              - generic [ref=e196]: "[60] 物理AI核心股池"
              - button "×" [ref=e197]
            - generic [ref=e198]: 18 只
          - generic [ref=e199] [cursor=pointer]:
            - generic [ref=e200]:
              - generic [ref=e201]: "[58] 周线多头排列+日线金叉"
              - button "×" [ref=e202]
            - generic [ref=e203]: 25 只
          - generic [ref=e204] [cursor=pointer]:
            - generic [ref=e205]:
              - generic [ref=e206]: "[57] 东方财富人气飙升榜TOP30"
              - button "×" [ref=e207]
            - generic [ref=e208]: 26 只
          - generic [ref=e209] [cursor=pointer]:
            - generic [ref=e210]:
              - generic [ref=e211]: "[56] 东方财富人气榜TOP30"
              - button "×" [ref=e212]
            - generic [ref=e213]: 30 只
          - generic [ref=e214] [cursor=pointer]:
            - generic [ref=e215]:
              - generic [ref=e216]: "[55] 雷达机会榜_20260609"
              - button "×" [ref=e217]
            - generic [ref=e218]: 20 只
          - generic [ref=e219] [cursor=pointer]:
            - generic [ref=e220]:
              - generic [ref=e221]: "[54] ML_自选股"
              - button "×" [ref=e222]
            - generic [ref=e223]: 50 只
          - generic [ref=e224] [cursor=pointer]:
            - generic [ref=e225]:
              - generic [ref=e226]: "[53] 自选股"
              - button "×" [ref=e227]
            - generic [ref=e228]: 276 只
          - generic [ref=e229] [cursor=pointer]:
            - generic [ref=e230]:
              - generic [ref=e231]: "[51] 周线金叉股_市值TOP20"
              - button "×" [ref=e232]
            - generic [ref=e233]: 20 只
          - generic [ref=e234] [cursor=pointer]:
            - generic [ref=e235]:
              - generic [ref=e236]: "[50] 周线多头排列_调整缩量_市值TOP9"
              - button "×" [ref=e237]
            - generic [ref=e238]: 9 只
          - generic [ref=e239] [cursor=pointer]:
            - generic [ref=e240]:
              - generic [ref=e241]: "[49] ML_算力概念股核心池_预测排序"
              - button "×" [ref=e242]
            - generic [ref=e243]: 13 只
          - generic [ref=e244] [cursor=pointer]:
            - generic [ref=e245]:
              - generic [ref=e246]: "[48] 算力概念股核心池"
              - button "×" [ref=e247]
            - generic [ref=e248]: 13 只
          - generic [ref=e249] [cursor=pointer]:
            - generic [ref=e250]:
              - generic [ref=e251]: "[23] 周线多头日线缩量回调_202605"
              - button "×" [ref=e252]
            - generic [ref=e253]: 30 只
        - generic [ref=e255]:
          - generic [ref=e256]: 📂
          - generic [ref=e257]: 选择股票池查看个股
    - generic [ref=e259]:
      - generic [ref=e263]:
        - generic [ref=e264]: 工具调用
        - button "收起" [ref=e265] [cursor=pointer]:
          - img [ref=e266]
      - generic [ref=e270]:
        - button "设置" [ref=e271] [cursor=pointer]:
          - img [ref=e272]
        - button "附件" [ref=e275] [cursor=pointer]:
          - img [ref=e276]
        - button "Choose File"
        - textbox "输入消息..." [ref=e278]
        - button "发送" [ref=e279] [cursor=pointer]:
          - img [ref=e280]
    - generic [ref=e283]:
      - generic [ref=e284]:
        - generic [ref=e285] [cursor=pointer]:
          - generic [ref=e286]: 📅 投资日历
          - generic [ref=e287]:
            - button "刷新日历数据" [ref=e288]:
              - img [ref=e289]
            - img [ref=e292]
        - generic [ref=e295]:
          - generic [ref=e296]:
            - button "<" [ref=e297] [cursor=pointer]
            - generic [ref=e298]: 2026年7月
            - button ">" [ref=e299] [cursor=pointer]
          - generic [ref=e300]:
            - generic [ref=e301]: 日
            - generic [ref=e302]: 一
            - generic [ref=e303]: 二
            - generic [ref=e304]: 三
            - generic [ref=e305]: 四
            - generic [ref=e306]: 五
            - generic [ref=e307]: 六
          - generic [ref=e308]:
            - generic [ref=e313] [cursor=pointer]: "1"
            - generic [ref=e317] [cursor=pointer]: "2"
            - generic [ref=e321] [cursor=pointer]: "3"
            - generic [ref=e323] [cursor=pointer]: "4"
            - generic [ref=e325] [cursor=pointer]: "5"
            - generic [ref=e327] [cursor=pointer]: "6"
            - generic [ref=e329] [cursor=pointer]: "7"
            - generic [ref=e331] [cursor=pointer]: "8"
            - generic [ref=e333] [cursor=pointer]: "9"
            - generic [ref=e335] [cursor=pointer]: "10"
            - generic [ref=e337] [cursor=pointer]: "11"
            - generic [ref=e339] [cursor=pointer]: "12"
            - generic [ref=e341] [cursor=pointer]: "13"
            - generic [ref=e343] [cursor=pointer]: "14"
            - generic [ref=e345] [cursor=pointer]: "15"
            - generic [ref=e347] [cursor=pointer]: "16"
            - generic [ref=e349] [cursor=pointer]: "17"
            - generic [ref=e351] [cursor=pointer]: "18"
            - generic [ref=e353] [cursor=pointer]: "19"
            - generic [ref=e355] [cursor=pointer]: "20"
            - generic [ref=e357] [cursor=pointer]: "21"
            - generic [ref=e359] [cursor=pointer]: "22"
            - generic [ref=e361] [cursor=pointer]: "23"
            - generic [ref=e363] [cursor=pointer]: "24"
            - generic [ref=e365] [cursor=pointer]: "25"
            - generic [ref=e369] [cursor=pointer]: "26"
            - generic [ref=e371] [cursor=pointer]: "27"
            - generic [ref=e373] [cursor=pointer]: "28"
            - generic [ref=e375] [cursor=pointer]: "29"
            - generic [ref=e377] [cursor=pointer]: "30"
            - generic [ref=e379] [cursor=pointer]: "31"
          - generic [ref=e380]:
            - generic [ref=e381]: 本月重点关注
            - generic [ref=e382] [cursor=pointer]:
              - generic [ref=e383]:
                - generic [ref=e385]: 07-01
                - generic [ref=e386]: 圆通速递 业绩预告
              - generic [ref=e387]: "最新价: 17.93; 最新涨跌幅: 3.462204; 公告日期: 20260701; 报告期[20260630]: 2026年中报; 净利润增长率上限[20260630]: 85.72999999999999"
            - generic [ref=e388] [cursor=pointer]:
              - generic [ref=e389]:
                - generic [ref=e391]: 07-01
                - generic [ref=e392]: 重庆钢铁 业绩预告
              - generic [ref=e393]: "最新价: 1.17; 最新涨跌幅: -1.6806720000000002; 公告日期: 20260701; 报告期[20260630]: 2026年中报; 净利润增长率上限[20260630]: -36.641200000000005"
            - generic [ref=e394] [cursor=pointer]:
              - generic [ref=e395]:
                - generic [ref=e397]: 07-01
                - generic [ref=e398]: 永太科技 业绩预告
              - generic [ref=e399]: "最新价: 28.0; 最新涨跌幅: 7.609531; 公告日期: 20260701; 报告期[20260630]: 2026年中报; 净利润增长率上限[20260630]: 461.21999999999997"
            - generic [ref=e400] [cursor=pointer]:
              - generic [ref=e401]:
                - generic [ref=e403]: 07-01
                - generic [ref=e404]: 益生股份 业绩预告
              - generic [ref=e405]: "最新价: 9.41; 最新涨跌幅: 10.05848; 公告日期: 20260701; 报告期[20260630]: 2026年中报; 净利润增长率上限[20260630]: 4774.01"
            - generic [ref=e406] [cursor=pointer]:
              - generic [ref=e407]:
                - generic [ref=e409]: 07-01
                - generic [ref=e410]: 中炬高新 业绩预告
              - generic [ref=e411]: "最新价: 18.91; 最新涨跌幅: 7.078143000000001; 公告日期: 20260701; 报告期[20260630]: 2026年中报; 净利润增长率上限[20260630]: 67.41"
            - generic [ref=e412] [cursor=pointer]:
              - generic [ref=e413]:
                - generic [ref=e415]: 07-01
                - generic [ref=e416]: 韶能股份 业绩预告
              - generic [ref=e417]: "最新价: 7.08; 最新涨跌幅: 9.937888000000001; 公告日期: 20260701; 报告期[20260630]: 2026年中报; 净利润增长率上限[20260630]: 103.33000000000001"
            - generic [ref=e418] [cursor=pointer]:
              - generic [ref=e419]:
                - generic [ref=e421]: 07-01
                - generic [ref=e422]: 金力永磁 业绩预告
              - generic [ref=e423]: "最新价: 33.0; 最新涨跌幅: 6.6235859999999995; 公告日期: 20260701; 报告期[20260630]: 2026年中报; 净利润增长率上限[20260630]: 50.839999999999996"
            - generic [ref=e424] [cursor=pointer]:
              - generic [ref=e425]:
                - generic [ref=e427]: 07-02
                - generic [ref=e428]: 孚日股份 业绩预告
              - generic [ref=e429]: "最新价: 11.16; 最新涨跌幅: -0.357143; 公告日期: 20260702; 报告期[20260630]: 2026年中报; 净利润增长率上限[20260630]: 70.27"
            - generic [ref=e430] [cursor=pointer]:
              - generic [ref=e431]:
                - generic [ref=e433]: 07-02
                - generic [ref=e434]: 东方铁塔 业绩预告
              - generic [ref=e435]: "最新价: 17.31; 最新涨跌幅: 0.8741260000000001; 公告日期: 20260702; 报告期[20260630]: 2026年中报; 净利润增长率上限[20260630]: 106.19000000000001"
            - generic [ref=e436] [cursor=pointer]:
              - generic [ref=e437]:
                - generic [ref=e439]: 07-02
                - generic [ref=e440]: 优彩资源 业绩预告
              - generic [ref=e441]: "最新价: 7.65; 最新涨跌幅: 10.071942; 公告日期: 20260702; 报告期[20260630]: 2026年中报; 净利润增长率上限[20260630]: 122.17"
            - generic [ref=e442] [cursor=pointer]:
              - generic [ref=e443]:
                - generic [ref=e445]: 07-02
                - generic [ref=e446]: 泰诺麦博 业绩预告
              - generic [ref=e447]: "公告日期: 20260702; 报告期[20260630]: 2026年中报; 净利润增长率上限[20260630]: 30.72; 净利润增长率下限[20260630]: 29.69; 变动类型[20260630]: 减亏"
            - generic [ref=e448] [cursor=pointer]:
              - generic [ref=e449]:
                - generic [ref=e451]: 07-02
                - generic [ref=e452]: 三瑞智能 业绩预告
              - generic [ref=e453]: "最新价: 135.05; 最新涨跌幅: 14.236170000000001; 公告日期: 20260702; 报告期[20260630]: 2026年中报; 净利润增长率上限[20260630]: 89.07000000000001"
            - generic [ref=e454] [cursor=pointer]:
              - generic [ref=e455]:
                - generic [ref=e457]: 预计
                - generic [ref=e458]: 中央政治局会议
              - generic [ref=e459]: 半年度经济工作部署 (2026年7月25-30日)
      - generic [ref=e460]:
        - generic [ref=e461] [cursor=pointer]:
          - generic [ref=e462]: 📰 财经新闻
          - img [ref=e463]
        - generic [ref=e466]:
          - generic "机器人概念持续走高 卧龙电驱等十余股涨停" [ref=e467]:
            - generic [ref=e468]:
              - generic [ref=e469]: 东财7x24
              - generic [ref=e470]: 07-03 10:06
            - generic [ref=e471]: 机器人概念持续走高 卧龙电驱等十余股涨停
            - generic [ref=e472]: 【机器人概念持续走高 卧龙电驱等十余股涨停】机器人概念持续走高，卧龙电驱、埃斯顿封涨停，此前日发精机、雷赛智能、晋拓股份、蓝黛科技等涨停，新睿电子触及30cm涨停，丰光精密、长盛轴承、绿的谐波等多股涨超10%。
          - generic "今年2000亿元“两新”设备更新资金已全部下达" [ref=e473]:
            - generic [ref=e474]:
              - generic [ref=e475]: 东财7x24
              - generic [ref=e476]: 07-03 10:05
            - generic [ref=e477]: 今年2000亿元“两新”设备更新资金已全部下达
            - generic [ref=e478]: 【今年2000亿元“两新”设备更新资金已全部下达】记者今天（7月3日）从国家发展改革委了解到，今年2000亿元超长期特别国债支持“两新”设备更新资金已全部下达。
          - generic "紫金矿业港股上涨9.65%" [ref=e479]:
            - generic [ref=e480]:
              - generic [ref=e481]: 东财7x24
              - generic [ref=e482]: 07-03 10:02
            - generic [ref=e483]: 紫金矿业港股上涨9.65%
            - generic [ref=e484]: 紫金矿业港股上涨9.65%，至30.90港元。
          - generic "MSCI亚太指数上涨1%" [ref=e485]:
            - generic [ref=e486]:
              - generic [ref=e487]: 东财7x24
              - generic [ref=e488]: 07-03 10:02
            - generic [ref=e489]: MSCI亚太指数上涨1%
            - generic [ref=e490]: MSCI亚太指数上涨1%至272.83点。
          - generic "恒指涨幅扩大至2%" [ref=e491]:
            - generic [ref=e492]:
              - generic [ref=e493]: 东财7x24
              - generic [ref=e494]: 07-03 09:59
            - generic [ref=e495]: 恒指涨幅扩大至2%
            - generic [ref=e496]: 恒指高开高走，日内涨幅扩大至2%。
          - generic "越南第二季度GDP同比增长8.39%" [ref=e497]:
            - generic [ref=e498]:
              - generic [ref=e499]: 东财7x24
              - generic [ref=e500]: 07-03 09:58
            - generic [ref=e501]: 越南第二季度GDP同比增长8.39%
            - generic [ref=e502]: 越南第二季度GDP同比增长8.39%。
          - generic "A股将迎“人形机器人第一股”！机器人ETF天弘（159770）标的指数盘中涨超2%，申购达600万份为深市同标的第一" [ref=e503]:
            - generic [ref=e504]:
              - generic [ref=e505]: 东财7x24
              - generic [ref=e506]: 07-03 09:58
            - generic [ref=e507]: A股将迎“人形机器人第一股”！机器人ETF天弘（159770）标的指数盘中涨超2%，申购达600万份为深市同标的第一
            - generic [ref=e508]: 【A股将迎”人形机器人第一股“！机器人ETF天弘（159770）标的指数盘中涨超2%，申购达600万份为深市同标的第一】盘面上，两市震荡上行，机器人概念上涨。相关ETF方面，机器人ETF天弘（159770）标的指数盘中涨2.05%，申购额达...
          - generic "沪深两市成交额突破1万亿元 较上一个交易日此时缩量超1500亿元" [ref=e509]:
            - generic [ref=e510]:
              - generic [ref=e511]: 东财7x24
              - generic [ref=e512]: 07-03 09:57
            - generic [ref=e513]: 沪深两市成交额突破1万亿元 较上一个交易日此时缩量超1500亿元
            - generic [ref=e514]: 沪深两市成交额突破1万亿元，较上一个交易日此时缩量超1500亿元。
          - generic "机器人带火这一轻量化新材料" [ref=e515]:
            - generic [ref=e516]:
              - generic [ref=e517]: 东财7x24
              - generic [ref=e518]: 07-03 09:57
            - generic [ref=e519]: 机器人带火这一轻量化新材料
            - generic [ref=e520]: 【机器人带火这一轻量化新材料】凭借轻量化、高减震、电磁屏蔽、散热优异等综合特性，镁合金正成为人形机器人核心结构件的优选基材，目前已应用于特斯拉Optimus Gen2、小鹏IRON、埃斯顿、智元机器人等多款机型。
          - generic "海南消费品以旧换新新增8类地方自主补贴品类" [ref=e521]:
            - generic [ref=e522]:
              - generic [ref=e523]: 东财7x24
              - generic [ref=e524]: 07-03 09:56
            - generic [ref=e525]: 海南消费品以旧换新新增8类地方自主补贴品类
            - generic [ref=e526]: 【海南消费品以旧换新新增8类地方自主补贴品类】海南省商务厅发布《关于新增海南省2026年消费品以旧换新地方自主补贴品类的公告》。根据《公告》，海南优化实施消费品以旧换新工作，在现有6类家电以旧换新、4类数码智能产品购新补贴基础上，新增实施8...
          - generic "1分钟涨停！000506、600988 2连板！" [ref=e527]:
            - generic [ref=e528]:
              - generic [ref=e529]: 东财7x24
              - generic [ref=e530]: 07-03 09:56
            - generic [ref=e531]: 1分钟涨停！000506、600988 2连板！
            - generic [ref=e532]: 【1分钟涨停！000506、600988 2连板！】贵金属板块走强。7月3日，贵金属板块延续强势，招金黄金（000506）、赤峰黄金（600988）盘初直线拉升涨停，在1分钟内涨停，均斩获2连板。
          - generic "玻璃基板概念集体调整 彩虹股份跌停" [ref=e533]:
            - generic [ref=e534]:
              - generic [ref=e535]: 东财7x24
              - generic [ref=e536]: 07-03 09:55
            - generic [ref=e537]: 玻璃基板概念集体调整 彩虹股份跌停
            - generic [ref=e538]: 玻璃基板概念集体调整，彩虹股份跌停，京东方A、力诺药包、红星发展、TCL科技、安彩高科纷纷下挫。
          - generic "我国首艘数智化改造海事公务船艇投入试用" [ref=e539]:
            - generic [ref=e540]:
              - generic [ref=e541]: 东财7x24
              - generic [ref=e542]: 07-03 09:55
            - generic [ref=e543]: 我国首艘数智化改造海事公务船艇投入试用
            - generic [ref=e544]: 【我国首艘数智化改造海事公务船艇投入试用】据交通运输部海事局，今天（7月3日），我国首艘数智化改造的海事公务船艇“海巡14102”在深圳投入试用。
          - generic "中国第16次北冰洋考察启航" [ref=e545]:
            - generic [ref=e546]:
              - generic [ref=e547]: 东财7x24
              - generic [ref=e548]: 07-03 09:54
            - generic [ref=e549]: 中国第16次北冰洋考察启航
            - generic [ref=e550]: 【中国第16次北冰洋考察启航】2026年7月3日，由自然资源部组织的中国第16次北冰洋考察队“雪龙”号、“雪龙2”号、北海局“极地”号从大连启航，这是“十五五”开局之年我国组织实施的首次北冰洋考察，由“雪龙”号、“雪龙2”号、北海局“极地”...
          - generic "光智科技成立新公司 含集成电路芯片业务" [ref=e551]:
            - generic [ref=e552]:
              - generic [ref=e553]: 东财7x24
              - generic [ref=e554]: 07-03 09:52
            - generic [ref=e555]: 光智科技成立新公司 含集成电路芯片业务
            - generic [ref=e556]: 【光智科技成立新公司 含集成电路芯片业务】企查查APP显示，近日，山东光智全谱科技有限公司成立，经营范围包含集成电路芯片及产品制造；集成电路芯片及产品销售；核子及核辐射测量仪器制造；太赫兹检测技术研发等。企查查股权穿透显示，该公司由光智科技...
```

# Test source

```ts
  1  | import { test, expect } from "@playwright/test";
  2  | 
  3  | test.describe("Weekly Kline Fallback", () => {
  4  | 	test("should fetch and render weekly klines from mootdx fallback when DB is empty", async ({ page }) => {
  5  | 		page.on("response", async (res) => {
  6  | 			if (res.url().includes("/api/klines")) {
  7  | 				try {
  8  | 					const json = await res.json();
  9  | 					console.log(`[API] ${res.url()} -> ${json.length} bars`);
  10 | 				} catch {
  11 | 					console.log(`[API] ${res.url()} -> non-json`);
  12 | 				}
  13 | 			}
  14 | 		});
  15 | 
  16 | 		await page.goto("/");
  17 | 		await page.waitForSelector("#stock-search-input", { timeout: 30000 });
  18 | 
  19 | 		// Use a stock that likely has no week data in DB to trigger mootdx fallback
  20 | 		await page.fill("#stock-search-input", "001237");
  21 | 		await page.waitForTimeout(500);
> 22 | 		await page.click(".search-dropdown-item");
     |              ^ Error: page.click: Test timeout of 60000ms exceeded.
  23 | 
  24 | 		await page.waitForSelector(".stock-chart-panel", { timeout: 15000 });
  25 | 		await page.waitForSelector("#kline-chart-container", { timeout: 15000 });
  26 | 		await page.waitForTimeout(1500);
  27 | 
  28 | 		const weekBtn = page.locator('[data-period="week"]');
  29 | 		await expect(weekBtn).toBeVisible();
  30 | 		await weekBtn.click();
  31 | 
  32 | 		// Wait longer for mootdx fallback
  33 | 		await page.waitForTimeout(4000);
  34 | 
  35 | 		const emptyMsg = page.locator(".chart-empty");
  36 | 		await expect(emptyMsg).toHaveCount(0);
  37 | 	});
  38 | });
  39 | 
```