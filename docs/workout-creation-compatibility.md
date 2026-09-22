# Structured workout creation compatibility (verified 2026-09-22)

The Training Result page's **How do I create my workout?** guide is informational.
It does not log in to a manufacturer, call a manufacturer API, send Kinesis
data, or synchronize a workout from Kinesis. The user creates and syncs the
workout in the manufacturer's own app or device. Menu names and availability
can vary by model, firmware, operating system, app version, and region.

| Platform | Guidance status | Scope confirmed by the official source |
| --- | --- | --- |
| Garmin Connect | Confirmed for compatible devices | Garmin Connect custom workouts can be built with steps and sent to a compatible Garmin device. |
| Apple Watch / iPhone | Confirmed in the documented Apple Watch flow | Apple documents custom workouts with warm-up, work/recovery intervals, cooldown, and time/distance/pace/heart-rate options where supported. |
| COROS | Confirmed for supported activity modes/devices | The COROS app can create custom workouts with warm-up, training, rest, cooldown, targets, and repeats. |
| Polar Flow | Confirmed for compatible Polar products | Polar Flow supports phased training targets and syncing them to a compatible watch. |
| Suunto | Conditional | Suunto documents structured workouts and syncing through SuuntoPlus Guides, but only watches supporting that feature are covered. |
| Samsung Health / Galaxy Watch | Conditional | Samsung documents workout routines and model-specific Galaxy Watch behavior; equivalent structured targets are not asserted for every model or region. |
| Xiaomi / Mi Fitness | Model-dependent | The official source describes workout options, but a single custom structured-workout creation and sync flow was not confirmed across Xiaomi wearables. |
| Huawei Health | Model-dependent | Huawei documents supported running plans and device interval features; custom step-by-step workout creation is not asserted across all products. |

## Official sources

- Garmin, [Creating a Custom Workout in Garmin Connect](https://support.garmin.com/en-CA/?faq=wZ52AaLbLG2GC1Lxu2l4k7&identifier=777730&tab=topics) — consulted 2026-09-22.
- Apple, [Create a Custom Workout on Apple Watch](https://support.apple.com/en-mn/guide/watch/create-a-custom-workout-apd66fcd5c5c/watchos) — consulted 2026-09-22.
- COROS, [Create Custom Workouts in Your COROS App](https://support.coros.com/hc/en-us/articles/47285577958932-Create-Custom-Workouts-in-Your-COROS-App) — consulted 2026-09-22.
- Polar, [How do I create training targets?](https://support.polar.com/us-en/how_do_i_create_training_targets) — consulted 2026-09-22.
- Suunto, [How can I create structured workouts with Suunto app?](https://www.suunto.com/Support/faq-articles/suunto-app/how-can-i-create-structured-workouts-with-suunto-app/) — consulted 2026-09-22.
- Samsung, [Work out with your Samsung Galaxy Watch](https://www.samsung.com/us/support/answer/ANS10006858/) — consulted 2026-09-22.
- Xiaomi, [What are workout options in Mi Fitness App?](https://www.mi.com/global/support/article/KA-108986/) — consulted 2026-09-22.
- Huawei, [Customizing running plans on your HUAWEI sports watch](https://consumer.huawei.com/en/support/content/en-us15850729/) — consulted 2026-09-22.

The guide intentionally does not turn a model-dependent or unconfirmed feature
into generic steps. In those cases it directs the reader to the exact model's
official documentation and mentions supported free-activity or interval modes
only when the cited source describes them.
