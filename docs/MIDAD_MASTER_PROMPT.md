MIDAD — الوصف الشامل والمرجع الموحد للمنصة

وثيقة مرجعية شاملة تجسد الرؤية والمنتج والوظائف والتشغيل والإدارة والصيانة ومتطلبات الجودة.

1. التعريف والرؤية



MIDAD هي منصة SaaS عربية أولاً، RTL، لإدارة ومراقبة الشركات والمشاريع والعمليات من مركز موحد. الهدف ليس مجرد تخزين البيانات، بل تحويل العمليات المتفرقة إلى بيئة تشغيل واضحة وقابلة للمتابعة والقياس واتخاذ القرار.

الفكرة الأساسية: أن يمتلك صاحب الشركة أو المدير مركز قيادة واحداً يرى منه حالة الشركة والمشاريع والعملاء والعقود والمشتريات والمهام والمؤشرات والتنبيهات، مع صلاحيات وأثر تدقيقي ومراقبة تشغيلية.

2. القيمة التي تقدمها MIDAD



• توحيد المعلومات والعمليات في منصة واحدة.

• تقليل الاعتماد على Excel والرسائل والملفات المتفرقة.

• إعطاء الإدارة رؤية واضحة لحالة المشاريع والعمليات.

• تحويل الأحداث والبيانات إلى مهام وتنبيهات ومؤشرات قابلة للتنفيذ.

• تحسين المتابعة والمساءلة من خلال الصلاحيات وسجل التدقيق.

• تمكين الإدارة من اكتشاف المشكلات مبكراً.

• توفير أساس قابل للتوسع للشركات والعملاء المتعددين.

3. المستخدمون ونموذج SaaS



MIDAD مصممة كنظام متعدد المستأجرين Multi-Tenant. لكل مؤسسة بياناتها ومساحاتها وصلاحياتها المعزولة. تشمل الأدوار الإدارية والتشغيلية بحسب الحاجة، مع RBAC وصلاحيات دقيقة.

يجب أن تكون حدود المؤسسة Tenant Isolation مضمونة على مستوى API وقاعدة البيانات والمنطق، وليس اعتماداً على إخفاء العناصر في الواجهة فقط.

4. مساحة العمل الرئيسية



• Dashboard للإدارة مع مؤشرات مختصرة وحالة الأعمال.

• Projects / Project Workspace لإدارة المشاريع ومراحلها ومهامها.

• Customers لإدارة العملاء والبيانات والعلاقات.

• Contracts لمتابعة العقود والالتزامات والمواعيد.

• Procurement للمشتريات والطلبات والموردين وسير الموافقات.

• Tasks / Activities للمهام والمتابعة والمسؤوليات.

• Reports / Analytics للتقارير والمؤشرات.

• Notifications للتنبيهات والأحداث المهمة.

• Search ومرشحات وفرز وتفاصيل قابلة للتنقل.

• سجل نشاط واضح عند الحاجة.

5. Project Workspace



كل مشروع يجب أن يملك مساحة عمل منظمة تتضمن المعلومات الأساسية، الحالة، المسؤولين، المهام، الأنشطة، المواعيد، الملفات أو المراجع المرتبطة، العقود والالتزامات ذات الصلة، المشتريات عند ارتباطها بالمشروع، والمؤشرات والتنبيهات.

الهدف أن يستطيع المدير الانتقال من الصورة العامة إلى تفاصيل المشروع ثم إلى العنصر الذي يحتاج تدخلاً، دون فقدان السياق.

6. العملاء والعقود والمشتريات



العملاء: ملف موحد للعميل، المشاريع المرتبطة، الأنشطة والمعلومات ذات الصلة.

العقود: بيانات العقد، حالته، التواريخ المهمة، الالتزامات والمتابعة، مع حماية أي منطق مالي حساس.

المشتريات: الطلبات، العناصر، الموردون، الحالات، الموافقات وسجل التغييرات. يجب ألا توجد انتقالات مالية أو حالات حرجة غير موثقة أو غير قابلة للتتبع.

7. التنبؤ والمتابعة



عند وجود Forecasting أو وظائف تنبؤ، يجب أن تكون النتائج مبنية على بيانات النظام وقواعد واضحة وقابلة للتفسير، مع الفصل بين البيانات الفعلية والتوقعات وعدم تقديم توقعات على أنها حقائق.

كل مخرجات حساسة يجب أن تكون قابلة للتتبع إلى المدخلات والمنهجية المستخدمة.

8. Admin Dashboard — مركز قيادة MIDAD



Admin Dashboard جزء أساسي من المنتج وليس صفحة إعدادات.

يتيح للإدارة العليا أو مالك المنصة:

• رؤية المؤسسات والعملاء والمستخدمين والمشاريع.

• البحث عن عميل أو مؤسسة والوصول إلى مساحة العمل الخاصة بها.

• رؤية حالة الحسابات والمشكلات التشغيلية.

• مراقبة صحة النظام والـAPI وقاعدة البيانات والمهام الخلفية.

• مشاهدة الأخطاء والحوادث والتنبيهات.

• تتبع النشاط وسجلات التدقيق.

• إدارة المستخدمين والصلاحيات والحالات.

• إدارة Feature Flags وMaintenance Mode عند الحاجة.

• الوصول إلى أدوات دعم وتشخيص منظمة.

• Drill-down من المؤشر العام إلى المؤسسة ثم المشروع ثم العنصر المتأثر.

أي أداة دعم عالية الصلاحية، مثل impersonation/support access، يجب أن تكون مقيدة، واضحة، قابلة للتدقيق، وآمنة، ولا تتحول إلى تجاوز صامت للصلاحيات.

9. المراقبة والصيانة والـObservability



MIDAD يجب أن تكون قابلة للصيانة بعد الإطلاق، وليس فقط قابلة للعرض.

تشمل الرؤية التشغيلية:

• Health Checks.

• API monitoring.

• Database health.

• Background jobs وjob status.

• Error tracking.

• Incident records.

• Alerts.

• Request IDs / Correlation IDs.

• Structured logs.

• مراقبة فشل العمليات.

• مراقبة المهام المتوقفة أو المتأخرة.

• Maintenance Mode.

• Feature Flags.

• معلومات كافية لتشخيص مشكلة العميل دون الوصول العشوائي إلى بياناته.

عند ظهور مشكلة لعميل، يجب أن يستطيع المسؤول معرفة أين حدثت المشكلة، ما العملية المتأثرة، ما الخطأ، ومتى حدث، ثم الانتقال إلى السياق الصحيح لإصلاحها.

10. الأمن والصلاحيات



• Authentication آمن.

• RBAC وصلاحيات دقيقة.

• Tenant isolation.

• Server-side authorization لكل عملية حساسة.

• حماية الجلسات والـAPI.

• Validation على المدخلات.

• منع الوصول المباشر إلى بيانات مؤسسة أخرى.

• Audit Logs للعمليات الحساسة.

• عدم وضع الأسرار في الواجهة أو المستودع.

• حماية البيانات الحساسة.

• عدم اعتبار الواجهة الأمامية طبقة أمان.

• Secure error handling دون تسريب تفاصيل داخلية.

• Request tracing للتشخيص.

11. Audit Trail



كل تغيير مهم يجب أن يكون قابلاً للتتبع: من قام به، ماذا تغير، متى حدث، وما السياق المرتبط به. يجب أن يكون سجل التدقيق موثوقاً ومفيداً في التحقيقات والدعم والمراجعة.

12. UX/UI



MIDAD عربية أولاً وRTL، مع واجهة احترافية وواضحة وقابلة للاستخدام من الهاتف وسطح المكتب.

المبادئ:

• البساطة قبل كثرة العناصر.

• Hierarchy بصري واضح.

• حالات loading / empty / error واضحة.

• رسائل خطأ مفهومة وقابلة للتصرف.

• عدم استخدام بيانات وهمية كأنها إنتاجية.

• اتساق المكونات والتنقل.

• وصول سريع من المؤشرات إلى التفاصيل.

• لا تُعرض ميزة غير منفذة على أنها منفذة.

13. الهندسة والتقنية



الخط التقني المرجعي الحالي: React 18 + Vite 5 + Tailwind 3 + TypeScript في العميل، وExpress + tRPC في الخادم، مع قاعدة بيانات تدعم العزل متعدد المستأجرين.

المبدأ الهندسي: discovery قبل modification، فهم معماري كامل قبل التعديل، تغييرات صغيرة ومحددة، عدم تعديل ملفات محمية بلا ضرورة، وعدم إدخال نطاقات مالية أو وظيفية غير مطلوبة في Slice لا تخصها.

14. API والبيانات



كل API يجب أن يطبق المصادقة والتفويض والتحقق من المدخلات والعزل بين المؤسسات. يجب أن تكون أنواع العميل والخادم متسقة، وأن تكون أخطاء API قابلة للفهم والتشخيص.

البيانات يجب أن تملك نماذج واضحة وعلاقات واتساقاً مناسباً، مع حماية العمليات الحساسة من الحالات الجزئية والتكرار غير المقصود.

15. الاختبارات والجودة



كل تغيير يجب أن يمر عبر بوابة تحقق مناسبة تشمل بحسب نطاق التغيير:

• Unit tests.

• Integration/server tests.

• Client tests.

• Typecheck.

• Build.

• Browser/UI verification عند الحاجة.

• Diff audit.

• Security/forbidden-scope grep عند الحاجة.

• Regression tests.

لا يعتبر Slice منتهياً لمجرد أن الكود يترجم؛ يجب إثبات السلوك المطلوب.

16. بروتوكول التطوير



قبل التعديل:

1. تثبيت Git state.


2. قراءة الملفات الحالية Fresh.


3. فهم architecture والاعتماديات.


4. تحديد النطاق والملفات المسموح تغييرها.



أثناء التنفيذ:

5. تنفيذ أصغر Slice مكتملة.


6. عدم patching blindly.


7. الحفاظ على العقود الحالية.


8. اختبار مبكر.



بعد التنفيذ:

9. Typecheck.


10. Tests.


11. Build.


12. Browser verification عند الحاجة.


13. Diff audit.


14. التأكد من عدم لمس النطاقات المحمية.


15. توثيق النتيجة والأدلة.


16. قواعد Stop / Failure / Done



STOP عند وجود غموض معماري جوهري، فشل غير مفهوم، انفصال UI عن الحالة الحقيقية، انتهاك نطاق، أو فشل أمني.

لا يتم تجاوز الفشل بإخفائه أو تعطيل الاختبارات.

DONE يعني أن السلوك المطلوب منفذ، الاختبارات المناسبة ناجحة، البناء ناجح، لا توجد تغييرات جانبية غير مصرح بها، والتحقق يثبت أن الميزة تعمل في السياق الحقيقي.

18. الفوترة والاستعداد التجاري



يجب تصميم المنتج بحيث يمكن إضافة Billing وPlans وSubscriptions وUsage Limits وEntitlements لاحقاً دون إعادة بناء النظام.

يجب فصل منطق الفوترة عن منطق الأعمال الأساسي، وعدم اختلاق عمليات دفع أو بيانات اشتراك وهمية على أنها حقيقية.

19. قابلية التوسع



MIDAD يجب أن تسمح بإضافة وحدات مستقبلية دون كسر الوحدات الحالية. البنية يجب أن تدعم نمو عدد المؤسسات والمستخدمين والمشاريع والعمليات، مع مراعاة الأداء، الفهارس، pagination، caching عند الحاجة، وتقليل الاستعلامات غير الضرورية.

20. المبدأ التشغيلي النهائي



MIDAD ليست مجموعة صفحات منفصلة. هي نظام تشغيل إداري مترابط:

بيانات → عمليات → حالات → مهام → تنبيهات → مؤشرات → تقارير → قرارات → سجل تدقيق → مراقبة وصيانة.

ويجب أن يستطيع صاحب المنصة إدارة العملاء، مراقبة صحة النظام، اكتشاف المشكلات، تشخيصها ومتابعة إصلاحها من Admin Dashboard، مع الحفاظ على الأمن والعزل وقابلية التتبع.

21. الوصف التسويقي المختصر



MIDAD هي منصة ذكية لإدارة الشركات والمشاريع من مكان واحد. تجمع العمليات والمعلومات المهمة في مركز قيادة موحد، وتمنح الإدارة رؤية واضحة للمشاريع والعملاء والعقود والمشتريات والمهام والمؤشرات، مع صلاحيات ومراقبة وسجل تدقيق وأدوات تشغيل وصيانة.

ببساطة: MIDAD تساعدك على رؤية شركتك، متابعة ما يحدث فيها، اكتشاف ما يحتاج إلى تدخل، وإدارة عملياتك من مكان واحد.

22. التعريف الاستراتيجي



MIDAD = Business Management + Operations + Project Workspace + Monitoring + Administration + Supportability في منصة SaaS واحدة.

الهدف النهائي هو بناء منتج Production-grade يمكن إطلاقه وبيعه وتشغيله وصيانته والتوسع به، وليس مجرد MVP شكلي أو مجموعة واجهات.

23. ملاحظة مرجعية للبرومت الشامل



هذه الوثيقة هي الوصف المنتجـي والتشغيلي الموحد لـMIDAD. يُستخدم البرومت الشامل كتعليمات تنفيذية صارمة عند التطوير، بينما تستخدم هذه الوثيقة كمرجع لما يجب أن تكون عليه المنصة وما يجب ألا يُغفل منها.




MIDAD — MASTER PROMPT

Canonical Product Specification + Development Governance + Architecture + Security + Operations

This document is the canonical, persistent source of truth for the MIDAD project.

It defines:

- what MIDAD is;
- what the finished product must provide;
- its architecture and security principles;
- its operational and administration requirements;
- its quality requirements;
- and the mandatory development protocol that must be followed in every future development session.

This document must be stored in the repository at:

"docs/MIDAD_MASTER_PROMPT.md"

It must be treated as a permanent project artifact.

---

PART I — PRODUCT VISION

1. Definition and Vision

MIDAD is an Arabic-first, RTL SaaS platform for managing and monitoring companies, projects, operations, customers, contracts, procurement, tasks, financial/project workflows, administration, and operational health from a unified control center.

The objective is not merely to store data.

The objective is to transform fragmented business operations into a clear, measurable, traceable operating environment.

The core idea is that a company owner or manager should have one central command center from which they can understand:

- company status;
- projects;
- customers;
- contracts;
- procurement;
- tasks;
- operational activity;
- indicators;
- alerts;
- users;
- permissions;
- audit history;
- system health;
- customer problems;
- and operational incidents.

MIDAD must be a production-grade SaaS product that can be launched, sold, operated, maintained, supported, secured, and scaled.

It must not become merely an MVP consisting of disconnected pages or superficial UI.

---

PART II — BUSINESS VALUE

MIDAD provides:

- unified information and workflows;
- reduced dependence on Excel, messaging applications, and scattered files;
- management visibility into projects and operations;
- conversion of events and data into actionable tasks, alerts, and indicators;
- stronger accountability through permissions and audit trails;
- earlier detection of operational problems;
- centralized administration and support;
- a scalable multi-tenant foundation.

The final system should allow management to move from:

overview → organization → project → process → item → problem → action

without losing context.

---

PART III — SAAS AND MULTI-TENANCY

MIDAD is a Multi-Tenant SaaS system.

Each organization/tenant must have:

- isolated data;
- isolated business context;
- appropriate users;
- roles;
- permissions;
- operational records.

Tenant isolation must be guaranteed at the server/API/database/business-logic level.

Frontend visibility is NEVER a security boundary.

Never rely on:

- hidden buttons;
- hidden pages;
- frontend-only permission checks;
- client-side filtering;
- route visibility;

to protect tenant data.

Every sensitive operation must enforce authorization server-side.

---

PART IV — TENANT PRODUCT

The tenant product should provide a coherent company/project operating environment.

Core areas

- Dashboard
- Projects
- Project Workspace
- Customers
- Contracts
- BOQ
- Cost Plan
- Procurement
- Actual Cost
- Measurements / Progress
- Owner IPC
- Subcontractor IPC
- Forecast
- Cash Flow
- Invoices
- Quotes
- Operations
- Tasks
- Daily Logs
- Documents
- Suppliers
- Team / Users
- Company Settings
- Reports / Analytics
- Notifications
- Search
- Activity / Audit history

These are not necessarily separate isolated products.

They form one connected operating system.

---

PART V — PROJECT WORKSPACE

Each project should provide an organized workspace containing, where applicable:

- project information;
- status;
- responsible users;
- tasks;
- activities;
- dates;
- documents/references;
- contracts;
- commitments;
- procurement;
- measurements;
- progress;
- IPC information;
- forecasts;
- cash-flow context;
- invoices;
- operational indicators;
- alerts.

The manager must be able to move from a high-level project view into the exact item requiring attention without losing context.

---

PART VI — CUSTOMERS

Customers must have a unified profile.

The system should support:

- customer identity;
- company information;
- contact information;
- related projects;
- related activities;
- relevant relationships.

Existing backward-compatible fields must not be broken merely to introduce the customer entity.

---

PART VII — CONTRACTS

Contracts should support:

- contract information;
- status;
- important dates;
- obligations;
- follow-up;
- associated project context;
- appropriate auditability.

Sensitive financial logic must remain protected.

Never introduce financial calculations or semantics into an unrelated slice.

---

PART VIII — PROCUREMENT

Procurement should support, where applicable:

- requests;
- purchase items;
- suppliers;
- statuses;
- approvals;
- commitments;
- changes;
- audit history.

No critical state or financial transition may be silently performed.

---

PART IX — FINANCIAL AND PROJECT INTEGRITY

Financial/project-sensitive functionality is a protected domain.

Particular care must be taken with:

- Forecast;
- Cash Flow;
- IPC;
- Subcontractor IPC;
- Measurements;
- Invoices;
- Quotes;
- financial calculations;
- committed costs;
- actual costs;
- project cost relationships.

Do not alter financial semantics unless the task explicitly requires it.

Do not reopen or refactor protected financial boundaries merely because they are nearby.

Do not introduce:

- speculative calculations;
- fake financial values;
- fake payment states;
- fake billing states;
- unverified financial assumptions.

Any financial-sensitive result must be traceable to its underlying data and methodology.

---

PART X — FORECASTING

Where forecasting exists:

- distinguish actual data from forecasts;
- never present forecasts as facts;
- use clearly defined rules;
- maintain traceability;
- make sensitive outputs explainable;
- preserve point-in-time integrity where applicable.

Every sensitive forecast output should be traceable to its inputs and methodology.

---

PART XI — ADMIN DASHBOARD

The Admin Dashboard is a core part of the product.

It is not merely a settings page.

It should ultimately provide the platform administrator with a command center for:

- organizations;
- users;
- customer context;
- operational status;
- system health;
- errors;
- incidents;
- alerts;
- audit history;
- support;
- diagnostics;
- maintenance;
- feature flags;
- platform-level operational controls.

The administrator should be able to drill down:

Platform → Organization → Project → Process → Item → Problem

where appropriate.

High-privilege support tools must always be:

- explicit;
- restricted;
- auditable;
- traceable;
- safe;
- reversible where appropriate.

They must never become silent permission bypasses.

---

PART XII — PLATFORM ADMINISTRATION

Platform administration is structurally separate from tenant authentication.

Platform operators must not be treated as tenant users.

Platform authentication must remain isolated from tenant authentication.

Platform support access must never fake:

- "req.userId";
- "req.companyId";

or otherwise conflate platform identity with tenant identity.

Support access must be:

- explicit;
- company-specific;
- time-bounded;
- revocable;
- DB-authoritative;
- auditable;
- attributable to the platform operator.

A platform operator must never automatically gain unrestricted access to every tenant.

---

PART XIII — SUPPORT ACCESS

Support sessions must be bound to exactly one target organization.

A support session should have, where applicable:

- operator identity;
- target organization;
- reason;
- creation time;
- expiration;
- revocation state;
- audit trail.

Support access must be checked against the database when access is granted/used where the architecture requires DB-authoritative revocation.

Expired or revoked sessions must not remain usable merely because a JWT remains cryptographically valid.

Support actions must be traceable.

No tenant mutation through support access may be introduced unless explicitly authorized by a future Product Owner decision.

---

PART XIV — OBSERVABILITY

MIDAD must be maintainable after launch.

Operational observability should ultimately include:

- health checks;
- API monitoring;
- database health;
- background job status;
- error tracking;
- incident records;
- alerts;
- request IDs;
- correlation IDs;
- structured logs;
- failed-operation monitoring;
- delayed/stuck-job monitoring;
- maintenance mode;
- feature flags;
- sufficient diagnostic context.

When a customer reports a problem, an administrator should be able to determine:

1. what happened;
2. where it happened;
3. which operation was affected;
4. when it happened;
5. which request caused it;
6. which organization/project context was involved;
7. what error occurred;
8. what action can be taken.

Diagnostics must not require uncontrolled access to customer data.

---

PART XV — AUDIT TRAIL

Important changes must be traceable.

Audit information should answer:

- who performed the action;
- what changed;
- when it happened;
- which organization/context was involved;
- what operation occurred;
- what relevant metadata exists.

Audit records must be reliable and useful for:

- support;
- investigation;
- accountability;
- security;
- compliance;
- operational diagnosis.

Never fabricate tenant identity for platform actors where the database model does not support it.

---

PART XVI — SECURITY

Security requirements:

- secure authentication;
- server-side authorization;
- RBAC;
- precise permissions;
- tenant isolation;
- platform isolation;
- input validation;
- secure session handling;
- secure API handling;
- audit logging;
- protection of sensitive information;
- no secrets in frontend code;
- no secrets committed to the repository;
- secure error handling;
- request tracing;
- no frontend-only security assumptions.

Authentication and authorization must remain authoritative on the server.

If an account is deactivated, existing valid credentials must not automatically retain access when the architecture requires immediate revocation.

---

PART XVII — UX / UI

MIDAD is Arabic-first and RTL-first.

The UI must be:

- professional;
- clear;
- consistent;
- responsive;
- usable on desktop and mobile;
- optimized for operational workflows.

Principles:

- simplicity before unnecessary complexity;
- clear visual hierarchy;
- clear loading states;
- clear empty states;
- clear error states;
- actionable error messages;
- consistent navigation;
- responsive layouts;
- rapid drill-down;
- no fake production data presented as real;
- no UI representing unfinished functionality as completed.

At approximately 390px width, important screens must not introduce accidental horizontal overflow.

---

PART XVIII — CURRENT TECHNOLOGY

The current reference stack is:

Client:

- React 18
- Vite 5
- TypeScript
- Tailwind CSS 3

Server:

- Express
- tRPC
- TypeScript

Database:

- relational database with tenant isolation and the existing project schema.

Do not replace core architecture without explicit justification and appropriate approval.

Always inspect the live repository before making assumptions.

---

PART XIX — API AND DATA

Every API must appropriately handle:

- authentication;
- authorization;
- validation;
- tenant isolation;
- platform isolation where applicable;
- consistent client/server types;
- safe errors;
- pagination where required;
- correct ownership;
- idempotency where required;
- transactional integrity for sensitive mutations.

Do not expose unnecessary fields.

Use allowlists for sensitive platform responses.

Do not expose secrets, internal credentials, or unnecessary tenant data.

---

PART XX — BILLING AND COMMERCIAL READINESS

The architecture should allow future introduction of:

- Billing;
- Plans;
- Subscriptions;
- Usage Limits;
- Entitlements.

Billing logic must remain separated from core business logic.

Never create fake payment information, fake subscription states, or fake billing integrations and represent them as real.

Billing is a separate future capability unless explicitly authorized.

---

PART XXI — SCALABILITY

MIDAD must support growth in:

- organizations;
- users;
- projects;
- operations;
- records.

Use appropriate:

- indexes;
- pagination;
- query optimization;
- caching where justified;
- efficient database access.

Do not add speculative infrastructure without evidence that it is required.

---

PART XXII — DEVELOPMENT GOVERNANCE

This section is mandatory for every future coding session.

Rule 1 — Discovery Before Modification

Never start by blindly editing code.

First:

1. confirm Git branch;
2. confirm HEAD;
3. confirm working tree;
4. inspect current repository state;
5. inspect relevant live files;
6. understand architecture;
7. identify existing implementations;
8. identify actual gaps;
9. identify dependencies;
10. identify protected scope.

Never infer that a feature is missing merely because an old document says it is missing.

Live code is the implementation truth.

---

PART XXIII — DOCUMENTATION VS LIVE CODE

This document is the canonical product specification.

However:

The live repository is the source of truth for implementation status.

Therefore:

- if this document says a feature should exist and the live repository already implements it, treat it as complete;
- do not rebuild it;
- do not duplicate it;
- do not replace working code unnecessarily.

If this document describes a future capability that does not yet exist, it is not automatically authorization to implement it.

First perform discovery and architecture gating.

---

PART XXIV — SLICE-BASED DEVELOPMENT

Work must be performed in small, complete, independently verifiable slices.

A Slice should have:

- clear objective;
- defined scope;
- defined files;
- defined security implications;
- defined tenant/platform implications;
- defined financial implications;
- defined tests;
- defined verification.

Do not mix unrelated improvements into the same slice.

Do not expand scope simply because a nearby improvement is tempting.

---

PART XXV — ARCHITECTURE GATE

Before implementing a new slice, explicitly determine:

1. Does it introduce a new role?
2. Does it introduce a new permission model?
3. Does it alter tenant isolation?
4. Does it alter platform isolation?
5. Does it alter authentication?
6. Does it alter authorization?
7. Does it alter financial semantics?
8. Does it touch protected files?
9. Does it require a database migration?
10. Does it introduce an external service?
11. Does it involve billing/pricing?
12. Does it involve notifications?
13. Does it require Product Owner policy?
14. Does it introduce background jobs?
15. Does it introduce a new client authentication model?
16. Does it alter an existing API contract?

If any answer reveals a significant architectural or product-policy decision that has not been approved:

STOP and request a decision.

Do not silently decide policy.

---

PART XXVI — PROTECTED SCOPE

Financially sensitive files and established security boundaries must not be modified merely for convenience.

At minimum, treat the following financial areas as protected unless a slice explicitly requires them:

- "forecast.ts"
- "lib/forecast.ts"
- "cashflow.ts"
- "lib/cashflow.ts"
- "ipcs.ts"
- "subcontractIpcs.ts"
- "measurements.ts"
- "invoices.ts"
- "quotes.ts"

Also protect established authentication/authorization foundations unless the task explicitly requires them:

- tenant authentication middleware;
- platform authentication middleware;
- permissions;
- established platform isolation.

If protected files must be modified, explain why before implementation and treat it as an architecture-gated change.

---

PART XXVII — DO NOT PATCH BLINDLY

Never fix a failing test or browser check by changing code blindly.

First determine:

- whether the failure is a product bug;
- test bug;
- environment problem;
- timing problem;
- fixture problem;
- rate-limit artifact;
- browser automation problem;
- architectural problem.

Then fix the actual cause.

---

PART XXVIII — TESTING REQUIREMENTS

Every meaningful change must receive appropriate verification.

Depending on scope:

- unit tests;
- server integration tests;
- client tests;
- typecheck;
- build;
- browser verification;
- HTTP verification;
- regression tests;
- security checks;
- diff audit.

A successful compilation is NOT proof that a feature works.

A test passing in isolation is NOT sufficient when the feature interacts with the live application.

---

PART XXIX — REAL VERIFICATION

When a feature affects real HTTP behavior:

perform real HTTP verification.

When a feature affects UI:

perform real browser verification where practical.

Do not claim browser verification if it was not performed.

Do not claim production verification when only local verification occurred.

Clearly distinguish:

- unit tests;
- integration tests;
- local HTTP tests;
- browser tests;
- production verification.

---

PART XXX — REGRESSION

Before declaring a slice complete:

- run relevant focused tests;
- run full regression when required;
- run client tests for client changes;
- run server tests for server changes;
- run typechecks;
- run builds.

No unrelated regression may be silently accepted.

---

PART XXXI — AUDITS

For security-sensitive or scope-sensitive changes, perform appropriate audits:

- "git diff --check";
- protected-file diff audit;
- financial-semantic grep where relevant;
- secret-leak grep;
- diff-scope audit;
- tenant-isolation verification;
- platform-isolation verification.

Do not dismiss audit results without inspecting them.

False positives must be explicitly verified rather than ignored.

---

PART XXXII — STOP CONDITIONS

STOP when:

- architecture is genuinely ambiguous;
- Product Owner policy is undefined;
- authorization semantics are unclear;
- tenant isolation could be weakened;
- platform isolation could be weakened;
- financial semantics could change unintentionally;
- a protected file must be changed without authorization;
- a security failure is unexplained;
- a test failure is being "fixed" blindly;
- UI state does not represent real backend state;
- implementation would require silently inventing requirements.

Never hide failures by:

- disabling tests;
- weakening assertions;
- removing validation;
- bypassing authorization;
- suppressing errors;
- changing the specification to make the implementation appear complete.

---

PART XXXIII — DONE CRITERIA

A Slice is DONE only when:

1. required behavior is implemented;
2. architecture remains coherent;
3. security boundaries remain intact;
4. tenant isolation remains intact;
5. platform isolation remains intact;
6. protected financial semantics remain intact;
7. relevant tests pass;
8. typecheck passes;
9. build passes;
10. real verification is completed where required;
11. no unauthorized scope was introduced;
12. the diff has been audited;
13. findings are documented;
14. a clean Git checkpoint exists.

---

PART XXXIV — GIT DISCIPLINE

Before implementation:

- establish the starting commit;
- establish clean/dirty state.

After implementation:

- inspect diff;
- verify expected files only;
- verify protected files;
- run required tests;
- commit the completed slice.

Do not push unless explicitly instructed.

Never reset, rewrite history, or discard unrelated user work without explicit authorization.

---

PART XXXV — FUTURE FEATURE POLICY

The following categories may require explicit Product Owner decisions depending on the exact implementation:

- additional platform roles;
- platform operator creation/deactivation authority;
- impersonation;
- tenant mutation through support access;
- billing;
- subscriptions;
- global notifications;
- maintenance mode policy;
- platform-wide feature flags;
- external monitoring providers;
- new external services;
- major authorization changes.

Do not implement these merely because they appear in this specification.

Use the Architecture Gate first.

---

PART XXXVI — CURRENT PLATFORM ADMIN PRINCIPLES

Platform administration must remain separate from tenant administration.

The platform layer may ultimately provide:

- organization management;
- organization search;
- support-session management;
- system health;
- incidents;
- operational diagnostics;
- audit visibility;
- maintenance controls;
- platform feature flags;
- other approved administration functions.

However, only already-authorized and unblocked capabilities should be implemented.

---

PART XXXVII — OPERATIONAL PRINCIPLE

MIDAD is not a collection of independent pages.

It is an operating system for business management:

Data → Processes → States → Tasks → Alerts → Indicators → Reports → Decisions → Audit Trail → Monitoring → Maintenance

The platform must allow management to understand what is happening, detect what requires attention, act on it, and trace what happened afterward.

---

PART XXXVIII — FINAL PRODUCT DEFINITION

MIDAD =
Business Management + Operations + Project Workspace + Monitoring + Administration + Supportability

in one SaaS platform.

The ultimate goal is a production-grade product that can be:

- launched;
- sold;
- operated;
- supported;
- maintained;
- secured;
- monitored;
- and scaled.

---

PART XXXIX — MARKETING DESCRIPTION

MIDAD is a smart platform for managing companies and projects from one place.

It brings together important operations and information in one command center, giving management clear visibility into:

- projects;
- customers;
- contracts;
- procurement;
- tasks;
- indicators;
- activity;
- administration;
- monitoring;
- audit history.

In simple terms:

MIDAD helps you see your company, understand what is happening, identify what requires attention, and manage your operations from one place.

---

PART XL — MANDATORY SESSION INSTRUCTION

At the beginning of EVERY future development session:

1. Read this file.
2. Confirm the current Git checkpoint.
3. Inspect the live repository.
4. Compare the specification with actual implementation.
5. Identify genuine remaining gaps.
6. Do not rely on stale gap documents.
7. Rank candidate slices by value, risk, dependencies, and authorization.
8. Perform the Architecture Gate.
9. STOP if Product Owner input is genuinely required.
10. Otherwise implement the smallest complete authorized slice.
11. Test early.
12. Verify real behavior.
13. Audit the diff.
14. Commit locally.
15. Do not push unless explicitly instructed.

---

CANONICAL RULE

The specification defines what MIDAD is intended to become.

The live repository defines what MIDAD already is.

Every development session must reconcile the two before changing anything.

Never assume.

Never rebuild completed functionality.

Never invent missing requirements.

Never bypass security.

Never weaken tenant isolation.

Never silently alter financial semantics.

Never patch blindly.

Always discover first.

Always implement the smallest justified slice.

Always verify.

Always leave a clean, traceable checkpoint.

---

DOCUMENT STATUS

This file is the canonical MIDAD Master Prompt and permanent project reference.

Future sessions must read and respect this document before implementation.

It does not itself authorize implementation of every future capability.

Authorization is determined per slice through fresh discovery and the Architecture Gate.
