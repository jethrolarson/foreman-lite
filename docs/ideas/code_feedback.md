Any abstractions that would make extension code read more clearly?
TaskRecord has optional properties which can be indicitive of improper state modeling.
TaskRecord mixes undefind and optional properties.
I prefer values to exceptions. Maybe we can return the HerdrError in union rather than throw it? As a bonus intermediary functions then become obvious that they're throwing which is not true now.
`catch { return undefined;` smells
