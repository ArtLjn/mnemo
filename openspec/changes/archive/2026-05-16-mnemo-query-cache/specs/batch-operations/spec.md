## ADDED Requirements

### Requirement: Batch add supports multiple facts in one call
The system SHALL support adding multiple facts in a single fact_store tool call.

Batch add interface:
- The `content` field SHALL accept either a string (single fact) or an array of strings (multiple facts)
- All facts in a batch SHALL share the same category and tags
- The response SHALL contain an array of results, one per fact

Individual result format:
- `fact_id`: number (or -1 on error)
- `status`: "added" | "updated" | "error"
- `reason`: optional string explaining the result

#### Scenario: Batch add multiple facts
- **WHEN** fact_store is called with action="add", content=["事实1", "事实2"], category="general"
- **THEN** the system SHALL process each fact sequentially
- **AND** return an array of results with fact_id and status for each

#### Scenario: Batch add with partial failure
- **WHEN** a batch contains one valid fact and one empty string
- **THEN** the valid fact SHALL be added successfully
- **AND** the empty string SHALL return an error status
- **AND** the overall response SHALL include all individual results

#### Scenario: Single fact add remains compatible
- **WHEN** fact_store is called with action="add", content="单条事实" (string, not array)
- **THEN** the system SHALL process it as a single fact
- **AND** return a single result object (backward compatible)

### Requirement: Batch remove supports multiple fact IDs
The system SHALL support removing multiple facts in a single fact_store tool call.

Batch remove interface:
- The `fact_id` field SHALL accept either a number (single) or an array of numbers (multiple)
- The response SHALL contain an array of results, one per fact_id

#### Scenario: Batch remove multiple facts
- **WHEN** fact_store is called with action="remove", fact_id=[1, 2, 3]
- **THEN** the system SHALL attempt to remove each fact
- **AND** return an array of {fact_id, removed: boolean} results
